/**
 * Database-backed sessions.
 *
 * The browser holds a single opaque 256-bit token in an HttpOnly, SameSite=Lax
 * cookie. Only the SHA-256 hash of that token is stored, so a database leak does
 * not hand out live sessions. Sessions are per device, can be listed and revoked
 * individually, and are always validated server-side.
 */
import { cookies, headers } from "next/headers";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { adminRoles, sessions, users } from "@/db/schema";
import { config } from "./config";
import { clientIp, describeUserAgent, hashIp, HttpError } from "./api";
import { randomToken, sha256Hex } from "./crypto";

export const SESSION_COOKIE = "pdfpro_session";

export type AdminRole = "admin" | "support";

export type SessionUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  /** Stored plan flag; authoritative entitlement is computed from subscriptions. */
  plan: "free" | "premium";
  accountStatus: "active" | "suspended";
  createdAt: string;
  isAdmin: boolean;
  adminRole: AdminRole | null;
};

export type AuthContext = {
  user: SessionUser;
  sessionId: string;
};

async function isSecureRequest(): Promise<boolean> {
  try {
    const h = await headers();
    const proto = h.get("x-forwarded-proto");
    if (proto) return proto.split(",")[0]!.trim() === "https";
  } catch {
    /* not in a request scope */
  }
  if (config.appUrl) return config.appUrl.startsWith("https://");
  return config.isProduction;
}

function sessionCookieOptions(secure: boolean, expiresAt: Date, value: string) {
  return {
    name: SESSION_COOKIE,
    value,
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

export async function createSession(
  userId: string,
  request: Request,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config.auth.sessionDays * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({
    userId,
    tokenHash: sha256Hex(token),
    userAgent: describeUserAgent(request.headers.get("user-agent")),
    ipHash: hashIp(clientIp(request)),
    expiresAt,
  });
  const store = await cookies();
  store.set(sessionCookieOptions(await isSecureRequest(), expiresAt, token));
  return { token, expiresAt };
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: await isSecureRequest(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

type UserRow = typeof users.$inferSelect;

async function loadAdminRole(userId: string): Promise<AdminRole | null> {
  const [row] = await db.select({ role: adminRoles.role }).from(adminRoles).where(eq(adminRoles.userId, userId)).limit(1);
  if (!row) return null;
  return row.role === "support" ? "support" : "admin";
}

export function toSessionUser(row: UserRow, role: AdminRole | null): SessionUser {
  return {
    id: row.id,
    email: row.email,
    emailVerified: Boolean(row.emailVerifiedAt),
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    plan: row.plan === "premium" ? "premium" : "free",
    accountStatus: row.accountStatus === "suspended" ? "suspended" : "active",
    createdAt: row.createdAt.toISOString(),
    isAdmin: role !== null,
    adminRole: role,
  };
}

/**
 * Reads the current session from the cookie. Returns null when there is no
 * cookie, the session is expired/revoked, or the account is suspended.
 */
export async function readSession(options: { touch?: boolean } = {}): Promise<AuthContext | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), isNull(sessions.revokedAt)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.session.expiresAt.getTime() <= Date.now()) return null;
  if (row.user.accountStatus !== "active") return null;

  if (options.touch) {
    const stale = Date.now() - row.session.lastSeenAt.getTime() > 60 * 60 * 1000;
    if (stale) {
      await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.session.id));
    }
  }

  const role = await loadAdminRole(row.user.id);
  return { user: toSessionUser(row.user, role), sessionId: row.session.id };
}

export async function requireSession(): Promise<AuthContext> {
  const session = await readSession({ touch: true });
  if (!session) throw new HttpError(401, "Please sign in to continue.", "unauthenticated");
  return session;
}

export async function requireVerifiedSession(): Promise<AuthContext> {
  const session = await requireSession();
  if (!session.user.emailVerified) {
    throw new HttpError(403, "Verify your email address to use this feature.", "email_unverified");
  }
  return session;
}

export async function requireAdmin(): Promise<AuthContext> {
  const session = await requireSession();
  if (!session.user.isAdmin) throw new HttpError(403, "Administrator access is required.", "forbidden");
  return session;
}

export async function revokeSessionByToken(token: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), isNull(sessions.revokedAt)));
}

export async function revokeSessionById(sessionId: string, userId: string): Promise<boolean> {
  const result = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return result.length > 0;
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        exceptSessionId ? sql`${sessions.id} <> ${exceptSessionId}` : sql`true`,
      ),
    )
    .returning({ id: sessions.id });
  return rows.length;
}

export async function listUserSessions(userId: string) {
  const rows = await db
    .select({
      id: sessions.id,
      userAgent: sessions.userAgent,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), sql`${sessions.expiresAt} > now()`))
    .orderBy(sql`${sessions.lastSeenAt} desc`)
    .limit(25);
  return rows.map((row) => ({
    id: row.id,
    device: row.userAgent ?? "Unknown device",
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }));
}

/**
 * Bootstrap administrators from ADMIN_EMAILS. Only ever applied to accounts
 * whose email ownership has been verified, so holding an address in the
 * environment list cannot be used to hijack an unverified account.
 */
export async function applyAdminBootstrap(user: { id: string; email: string; emailVerifiedAt: Date | null }): Promise<boolean> {
  if (!config.admin.emails.length) return false;
  if (!user.emailVerifiedAt) return false;
  if (!config.admin.emails.includes(user.email.toLowerCase())) return false;
  await db.insert(adminRoles).values({ userId: user.id, role: "admin" }).onConflictDoNothing();
  return true;
}
