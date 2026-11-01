import { NextResponse } from "next/server";
import { assertSameOrigin, errorResponse, readJson } from "@/lib/server/api";
import { verifyCheckoutReturn } from "@/lib/server/payments/billing";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { requireSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Called by /billing/return after the hosted checkout. The browser-supplied
 * tracker is only a lookup key: the signature is verified and the payment state
 * is fetched from Safepay's API before Premium can be granted.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    await enforceRateLimit(`verify-return:${session.user.id}`, 30, 900);
    const body = await readJson<{ paymentId?: string; tracker?: string; signature?: string }>(request);
    const paymentId = String(body.paymentId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(paymentId)) {
      return NextResponse.json({ error: "A valid payment id is required." }, { status: 400 });
    }
    const result = await verifyCheckoutReturn({
      paymentId,
      userId: session.user.id,
      tracker: body.tracker ? String(body.tracker) : null,
      signature: body.signature ? String(body.signature) : null,
      request,
    });
    return NextResponse.json({ ok: result.status === "paid", ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
