import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { profiles, users } from "@/db/schema";
import { assertSameOrigin, errorResponse, readJson } from "@/lib/server/api";
import { sanitizeText } from "@/lib/server/crypto";
import { getEntitlements } from "@/lib/server/entitlements";
import { listUserPayments, listUserNotifications } from "@/lib/server/payments/billing";
import { listUserSessions, requireSession } from "@/lib/server/session";
import { buildSessionPayload } from "@/lib/server/session-payload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireSession();
    const entitlements = await getEntitlements(session.user.id);
    const [profile] = await db.select().from(profiles).where(eq(profiles.userId, session.user.id)).limit(1);
    const [sessions, payments, notifications] = await Promise.all([
      listUserSessions(session.user.id),
      listUserPayments(session.user.id, 25),
      listUserNotifications(session.user.id, 20),
    ]);

    return NextResponse.json({
      ok: true,
      user: { ...session.user, plan: entitlements.plan },
      profile: profile
        ? {
            fullName: profile.fullName,
            company: profile.company,
            country: profile.country,
            timezone: profile.timezone,
            marketingOptIn: profile.marketingOptIn,
          }
        : null,
      entitlements,
      sessions,
      currentSessionId: session.sessionId,
      payments,
      notifications,
      features: (await buildSessionPayload()).features,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    const body = await readJson<{
      displayName?: string;
      fullName?: string;
      company?: string;
      country?: string;
      timezone?: string;
      marketingOptIn?: boolean;
    }>(request);

    const displayName = body.displayName === undefined ? undefined : sanitizeText(body.displayName, 80);
    const fullName = body.fullName === undefined ? undefined : sanitizeText(body.fullName, 120);
    const company = body.company === undefined ? undefined : sanitizeText(body.company, 120);
    const country = body.country === undefined ? undefined : sanitizeText(body.country, 60);
    const timezone = body.timezone === undefined ? undefined : sanitizeText(body.timezone, 60);

    if (displayName !== undefined) {
      await db.update(users).set({ displayName: displayName || null, updatedAt: new Date() }).where(eq(users.id, session.user.id));
    }
    await db
      .insert(profiles)
      .values({
        userId: session.user.id,
        fullName: fullName ?? displayName ?? null,
        company: company ?? null,
        country: country ?? null,
        timezone: timezone ?? null,
        marketingOptIn: Boolean(body.marketingOptIn),
      })
      .onConflictDoUpdate({
        target: profiles.userId,
        set: {
          ...(fullName !== undefined ? { fullName: fullName || null } : {}),
          ...(company !== undefined ? { company: company || null } : {}),
          ...(country !== undefined ? { country: country || null } : {}),
          ...(timezone !== undefined ? { timezone: timezone || null } : {}),
          ...(body.marketingOptIn !== undefined ? { marketingOptIn: Boolean(body.marketingOptIn) } : {}),
          updatedAt: new Date(),
        },
      });

    return NextResponse.json({ ok: true, message: "Profile updated." });
  } catch (error) {
    return errorResponse(error);
  }
}
