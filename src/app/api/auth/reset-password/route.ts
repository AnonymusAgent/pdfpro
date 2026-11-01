import { NextResponse } from "next/server";
import { assertSameOrigin, errorResponse, readJson } from "@/lib/server/api";
import { resetPasswordWithToken } from "@/lib/server/auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await enforceRateLimit("reset-password", 20, 3600);
    const body = await readJson<{ token?: string; password?: string }>(request);
    const result = await resetPasswordWithToken(String(body.token ?? ""), String(body.password ?? ""));
    return NextResponse.json({
      ok: true,
      email: result.email,
      message: "Your password was updated. Sign in with your new password.",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
