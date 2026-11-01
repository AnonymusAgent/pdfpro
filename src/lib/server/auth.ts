/**
 * Account lifecycle: registration, verification, login, password reset and
 * Google sign-in.
 *
 * All password and token handling happens here on the server. The browser only
 * ever receives an opaque session cookie.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { emailTokens, oauthAccounts, profiles, storageUsage, users } from "@/db/schema";
import { config, resolveAppUrl } from "./config";
import { HttpError } from "./api";
import {
  burnPasswordCompare,
  hashPassword,
  randomToken,
  sanitizeText,
  sha256Hex,
  verifyPassword,
} from "./crypto";
import { sendEmail } from "./email";
import { passwordResetEmail, verificationEmail } from "./auth-emails";
import { applyAdminBootstrap, createSession, revokeAllSessions } from "./session";

export const MIN_PASSWORD_LENGTH = 10;

/** Deliberately permissive: one @, a dot in the domain, no whitespace. */
export function isValidEmail(email: string): boolean {
  return email.length <= 320 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const WEAK_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "12345678910",
  "qwertyuiop",
  "letmein123",
  "pdfpro1234",
  "admin12345",
  "iloveyou1",
]);

export function validatePassword(password: string, email?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 200) return "Use 200 characters or fewer.";
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return "Include at least one letter and one number.";
  if (WEAK_PASSWORDS.has(password.toLowerCase())) return "That password is too common. Choose something else.";
  if (email && password.toLowerCase().includes(email.split("@")[0]!.toLowerCase())) {
    return "Do not use your email address in your password.";
  }
  return null;
}

export type PublicUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  createdAt: string;
};

export type RegisterInput = {
  email: string;
  password: string;
  displayName?: string;
  marketingOptIn?: boolean;
  request: Request;
};

export type RegisterResult = {
  user: PublicUser;
  verificationPreviewUrl?: string;
  emailDelivered: boolean;
  emailTransport: string;
};

/**
 * Drizzle wraps driver errors (DrizzleQueryError), so the PostgreSQL SQLSTATE
 * can live on the error itself or anywhere down the `cause` chain.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object" && current !== null) {
      const code = (current as { code?: unknown }).code;
      if (code === "23505") return true;
      current = (current as { cause?: unknown }).cause;
    } else {
      return false;
    }
  }
  return false;
}

async function createEmailToken(userId: string, kind: "verify_email" | "reset_password"): Promise<string> {
  const token = randomToken(32);
  const ttlMs =
    kind === "verify_email" ? config.auth.verifyTokenHours * 3600_000 : config.auth.resetTokenMinutes * 60_000;
  await db
    .update(emailTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.kind, kind), isNull(emailTokens.usedAt)));
  await db.insert(emailTokens).values({
    userId,
    kind,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return token;
}

async function sendVerification(userId: string, email: string, displayName: string | null, request?: Request) {
  const token = await createEmailToken(userId, "verify_email");
  const url = `${resolveAppUrl(request)}/verify-email?token=${encodeURIComponent(token)}`;
  const template = verificationEmail({ displayName, url });
  const result = await sendEmail({ to: email, kind: "verify_email", ...template });
  return { url, delivered: result.delivered, transport: result.transport };
}

export async function registerUser(input: RegisterInput): Promise<RegisterResult> {
  const email = normalizeEmail(input.email ?? "");
  if (!isValidEmail(email)) throw new HttpError(400, "Enter a valid email address.", "invalid_email");
  const passwordError = validatePassword(input.password ?? "", email);
  if (passwordError) throw new HttpError(400, passwordError, "weak_password");

  const displayName = sanitizeText(input.displayName, 80) || null;
  const passwordHash = await hashPassword(input.password);

  let userId: string;
  try {
    userId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({ email, emailNormalized: email, passwordHash, displayName })
        .returning({ id: users.id });
      const id = row!.id;
      await tx.insert(profiles).values({
        userId: id,
        fullName: displayName,
        marketingOptIn: Boolean(input.marketingOptIn),
      });
      await tx.insert(storageUsage).values({ userId: id });
      return id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "An account already exists for this email address.", "email_taken");
    }
    throw error;
  }

  await createSession(userId, input.request);
  const verification = await sendVerification(userId, email, displayName, input.request);

  return {
    user: {
      id: userId,
      email,
      emailVerified: false,
      displayName,
      createdAt: new Date().toISOString(),
    },
    verificationPreviewUrl:
      config.auth.exposeDevLinks && verification.transport === "console" ? verification.url : undefined,
    emailDelivered: verification.delivered,
    emailTransport: verification.transport,
  };
}

export async function loginUser(params: {
  email: string;
  password: string;
  request: Request;
}): Promise<{ user: PublicUser; isAdmin: boolean }> {
  const email = normalizeEmail(params.email ?? "");
  if (!email || !params.password) throw new HttpError(400, "Email and password are required.", "invalid_credentials");

  const [row] = await db.select().from(users).where(eq(users.emailNormalized, email)).limit(1);
  if (!row) {
    await burnPasswordCompare(params.password);
    throw new HttpError(401, "Email or password is incorrect.", "invalid_credentials");
  }
  if (!row.passwordHash) {
    await burnPasswordCompare(params.password);
    throw new HttpError(
      401,
      "This account signs in with Google. Use “Continue with Google” instead.",
      "oauth_only_account",
    );
  }
  const valid = await verifyPassword(params.password, row.passwordHash);
  if (!valid) throw new HttpError(401, "Email or password is incorrect.", "invalid_credentials");
  if (row.accountStatus !== "active") {
    throw new HttpError(403, "This account is suspended. Contact support.", "account_suspended");
  }

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.id));
  const isAdmin = await applyAdminBootstrap(row);
  await createSession(row.id, params.request);

  return {
    user: {
      id: row.id,
      email: row.email,
      emailVerified: Boolean(row.emailVerifiedAt),
      displayName: row.displayName,
      createdAt: row.createdAt.toISOString(),
    },
    isAdmin,
  };
}

export async function resendVerification(userId: string, request?: Request): Promise<{ previewUrl?: string }> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!row) throw new HttpError(404, "Account not found.", "not_found");
  if (row.emailVerifiedAt) throw new HttpError(400, "Your email address is already verified.", "already_verified");
  const result = await sendVerification(row.id, row.email, row.displayName, request);
  return { previewUrl: config.auth.exposeDevLinks && result.transport === "console" ? result.url : undefined };
}

export async function verifyEmailToken(token: string): Promise<{ email: string; alreadyVerified: boolean }> {
  if (!token || token.length > 200) throw new HttpError(400, "This verification link is not valid.", "invalid_token");
  const hash = sha256Hex(token);
  const [record] = await db.select().from(emailTokens).where(eq(emailTokens.tokenHash, hash)).limit(1);
  if (!record || record.kind !== "verify_email") {
    throw new HttpError(400, "This verification link is not valid.", "invalid_token");
  }
  const [user] = await db.select().from(users).where(eq(users.id, record.userId)).limit(1);
  if (!user) throw new HttpError(400, "This verification link is not valid.", "invalid_token");

  if (user.emailVerifiedAt) {
    // Idempotent for already-verified accounts: opening an old link shows a
    // friendly message instead of an error, and changes nothing.
    return { email: user.email, alreadyVerified: true };
  }
  if (record.usedAt) {
    throw new HttpError(400, "This verification link has already been used. Request a new one.", "token_used");
  }
  if (record.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(400, "This verification link has expired. Request a new one.", "expired_token");
  }

  await db.transaction(async (tx) => {
    await tx.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, record.id));
    await tx.update(users).set({ emailVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id));
  });

  await applyAdminBootstrap({ ...user, emailVerifiedAt: new Date() });
  return { email: user.email, alreadyVerified: false };
}

/** Always resolves, so the endpoint cannot be used to enumerate accounts. */
export async function requestPasswordReset(emailInput: string, request?: Request): Promise<{ previewUrl?: string }> {
  const email = normalizeEmail(emailInput ?? "");
  if (!isValidEmail(email)) return {};
  const [user] = await db.select().from(users).where(eq(users.emailNormalized, email)).limit(1);
  if (!user || user.accountStatus !== "active") return {};

  const token = await createEmailToken(user.id, "reset_password");
  const url = `${resolveAppUrl(request)}/reset-password?token=${encodeURIComponent(token)}`;
  const template = passwordResetEmail({ displayName: user.displayName, url });
  const result = await sendEmail({ to: user.email, kind: "reset_password", ...template });
  return { previewUrl: config.auth.exposeDevLinks && result.transport === "console" ? url : undefined };
}

export async function resetPasswordWithToken(token: string, password: string): Promise<{ email: string }> {
  if (!token || token.length > 200) throw new HttpError(400, "This reset link is not valid.", "invalid_token");
  const passwordError = validatePassword(password);
  if (passwordError) throw new HttpError(400, passwordError, "weak_password");

  const hash = sha256Hex(token);
  const [record] = await db
    .select()
    .from(emailTokens)
    .where(and(eq(emailTokens.tokenHash, hash), eq(emailTokens.kind, "reset_password")))
    .limit(1);
  if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(400, "This reset link has expired or was already used.", "invalid_token");
  }
  const [user] = await db.select().from(users).where(eq(users.id, record.userId)).limit(1);
  if (!user) throw new HttpError(400, "This reset link is not valid.", "invalid_token");

  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await tx.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, record.id));
  });
  await revokeAllSessions(user.id);
  return { email: user.email };
}

export async function changePassword(params: {
  userId: string;
  currentPassword: string | null;
  newPassword: string;
  keepSessionId?: string;
}): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, params.userId)).limit(1);
  if (!user) throw new HttpError(404, "Account not found.", "not_found");
  if (user.passwordHash) {
    const ok = await verifyPassword(params.currentPassword ?? "", user.passwordHash);
    if (!ok) throw new HttpError(400, "Your current password is incorrect.", "invalid_password");
  }
  const passwordError = validatePassword(params.newPassword, user.email);
  if (passwordError) throw new HttpError(400, passwordError, "weak_password");
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(params.newPassword), updatedAt: new Date() })
    .where(eq(users.id, user.id));
  await revokeAllSessions(user.id, params.keepSessionId);
}

/* ------------------------------------------------------------------ */
/* Google sign-in (OAuth 2.0 authorisation code + PKCE)                */
/* ------------------------------------------------------------------ */

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

export function googleRedirectUri(request?: Request): string {
  return `${resolveAppUrl(request)}/api/auth/google/callback`;
}

export function buildGoogleAuthUrl(params: { state: string; codeChallenge: string; redirectUri: string; loginHint?: string }): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.google.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
  return url.toString();
}

type GoogleProfile = { sub: string; email: string; email_verified: boolean; name?: string; picture?: string };

export async function exchangeGoogleCode(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<GoogleProfile> {
  const body = new URLSearchParams({
    code: params.code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
    code_verifier: params.codeVerifier,
  });
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new HttpError(400, "Google sign-in could not be completed. Please try again.", "google_exchange_failed");
  }
  const token = (await response.json()) as { access_token?: string };
  if (!token.access_token) {
    throw new HttpError(400, "Google sign-in could not be completed. Please try again.", "google_exchange_failed");
  }
  const infoResponse = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!infoResponse.ok) {
    throw new HttpError(400, "Google did not return your profile. Please try again.", "google_userinfo_failed");
  }
  const profile = (await infoResponse.json()) as GoogleProfile;
  if (!profile.email || !profile.email_verified) {
    throw new HttpError(400, "Your Google account has no verified email address.", "google_email_unverified");
  }
  return profile;
}

export async function signInWithGoogle(params: {
  profile: GoogleProfile;
  request: Request;
}): Promise<{ userId: string; created: boolean }> {
  const email = normalizeEmail(params.profile.email);

  const [link] = await db
    .select({ userId: oauthAccounts.userId })
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.provider, "google"), eq(oauthAccounts.providerAccountId, params.profile.sub)))
    .limit(1);

  if (link) {
    const [user] = await db.select().from(users).where(eq(users.id, link.userId)).limit(1);
    if (!user) throw new HttpError(400, "This Google account is no longer linked. Please sign up again.", "oauth_orphan");
    if (user.accountStatus !== "active") throw new HttpError(403, "This account is suspended.", "account_suspended");
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    await applyAdminBootstrap(user);
    await createSession(user.id, params.request);
    return { userId: user.id, created: false };
  }

  const [existing] = await db.select().from(users).where(eq(users.emailNormalized, email)).limit(1);
  if (existing) {
    if (existing.accountStatus !== "active") throw new HttpError(403, "This account is suspended.", "account_suspended");
    await db.transaction(async (tx) => {
      await tx
        .insert(oauthAccounts)
        .values({ userId: existing.id, provider: "google", providerAccountId: params.profile.sub })
        .onConflictDoNothing();
      await tx
        .update(users)
        .set({
          emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
          avatarUrl: existing.avatarUrl ?? params.profile.picture ?? null,
          lastLoginAt: new Date(),
        })
        .where(eq(users.id, existing.id));
    });
    await applyAdminBootstrap({ ...existing, emailVerifiedAt: existing.emailVerifiedAt ?? new Date() });
    await createSession(existing.id, params.request);
    return { userId: existing.id, created: false };
  }

  const displayName = sanitizeText(params.profile.name, 80) || null;
  const userId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(users)
      .values({
        email,
        emailNormalized: email,
        emailVerifiedAt: new Date(),
        displayName,
        avatarUrl: params.profile.picture ?? null,
        lastLoginAt: new Date(),
      })
      .returning({ id: users.id });
    const id = row!.id;
    await tx.insert(profiles).values({ userId: id, fullName: displayName });
    await tx.insert(storageUsage).values({ userId: id });
    await tx.insert(oauthAccounts).values({ userId: id, provider: "google", providerAccountId: params.profile.sub });
    return id;
  });

  const [created] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (created) await applyAdminBootstrap(created);
  await createSession(userId, params.request);
  return { userId, created: true };
}
