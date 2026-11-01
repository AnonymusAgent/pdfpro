import { NextResponse } from "next/server";
import { assertSameOrigin, errorResponse, readJson } from "@/lib/server/api";
import { changePassword } from "@/lib/server/auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { requireSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    await enforceRateLimit(`change-password:${session.user.id}`, 6, 3600);
    const body = await readJson<{ currentPassword?: string; newPassword?: string }>(request);
    await changePassword({
      userId: session.user.id,
      currentPassword: body.currentPassword ? String(body.currentPassword) : null,
      newPassword: String(body.newPassword ?? ""),
      keepSessionId: session.sessionId,
    });
    return NextResponse.json({ ok: true, message: "Password updated. Other devices were signed out." });
  } catch (error) {
    return errorResponse(error);
  }
}
