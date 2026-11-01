import { NextResponse } from "next/server";
import { assertSameOrigin, clientIp, errorResponse, hashIp, readJson } from "@/lib/server/api";
import { requestPasswordReset } from "@/lib/server/auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJson<{ email?: string }>(request);
    const email = String(body.email ?? "").trim().toLowerCase();
    await enforceRateLimit(`forgot:ip:${hashIp(clientIp(request))}`, 10, 3600);
    await enforceRateLimit(`forgot:acct:${email}`, 4, 3600);
    const result = await requestPasswordReset(email, request);
    // Same response whether or not the account exists.
    return NextResponse.json({
      ok: true,
      message: "If an account exists for that address, a reset link is on its way.",
      ...(result.previewUrl ? { previewUrl: result.previewUrl } : {}),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
