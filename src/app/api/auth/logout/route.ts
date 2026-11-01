import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { assertSameOrigin, errorResponse } from "@/lib/server/api";
import { clearSessionCookie, revokeSessionByToken, SESSION_COOKIE } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (token) await revokeSessionByToken(token);
    await clearSessionCookie();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
