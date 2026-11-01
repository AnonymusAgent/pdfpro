import { NextResponse } from "next/server";
import { assertSameOrigin, errorResponse } from "@/lib/server/api";
import { resendVerification } from "@/lib/server/auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { requireSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    await enforceRateLimit(`resend-verify:${session.user.id}`, 5, 3600);
    const result = await resendVerification(session.user.id, request);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
