import { NextResponse } from "next/server";
import { assertSameOrigin, errorResponse, readJson } from "@/lib/server/api";
import { createCheckout } from "@/lib/server/payments/billing";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { requireSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Creates a hosted checkout session. The response contains a redirect URL only —
 * Premium is never granted here. Activation happens exclusively in the verified
 * webhook / server-side payment lookup.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    if (!session.user.emailVerified) {
      return NextResponse.json(
        { error: "Verify your email address before subscribing.", code: "email_unverified" },
        { status: 403 },
      );
    }
    await enforceRateLimit(`checkout:${session.user.id}`, 10, 3600);
    const body = await readJson<{ planId?: string }>(request);
    const result = await createCheckout({
      userId: session.user.id,
      userEmail: session.user.email,
      userName: session.user.displayName,
      planId: String(body.planId ?? ""),
      request,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
