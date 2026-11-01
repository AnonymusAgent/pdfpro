import { NextResponse } from "next/server";
import { clientIp } from "@/lib/server/api";
import { processProviderWebhook } from "@/lib/server/payments/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Safepay webhook endpoint.
 *
 * • Raw body is read as text so the HMAC-SHA512 signature can be verified
 *   byte-for-byte.
 * • Every delivery is stored in `payment_webhook_events` with a unique
 *   (provider, event id) key; duplicates are acknowledged with 200 and no
 *   side effects.
 * • A failed signature is rejected with 401 and never processed.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature =
    request.headers.get("x-sfpy-signature") ??
    request.headers.get("x-sfpy-signature".toUpperCase()) ??
    request.headers.get("X-SFPY-SIGNATURE");

  const result = await processProviderWebhook({
    providerId: "safepay",
    rawBody,
    signature,
    request,
  });

  console.info("[billing] safepay webhook", {
    ip: clientIp(request),
    duplicate: result.duplicate,
    outcome: result.outcome,
    status: result.status,
    bytes: rawBody.length,
  });

  if (result.status === 401) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }
  return NextResponse.json({ received: result.received, duplicate: result.duplicate, outcome: result.outcome }, { status: result.status });
}
