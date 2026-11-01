import { NextResponse } from "next/server";
import { assertSameOrigin, clientIp, errorResponse, hashIp, readJson } from "@/lib/server/api";
import { loginUser } from "@/lib/server/auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { buildSessionPayload } from "@/lib/server/session-payload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJson<{ email?: string; password?: string }>(request);
    const email = String(body.email ?? "").trim().toLowerCase();
    const ipHash = hashIp(clientIp(request));

    await enforceRateLimit(`login:ip:${ipHash}`, 20, 900);
    await enforceRateLimit(`login:acct:${email}`, 8, 900);

    await loginUser({ email, password: String(body.password ?? ""), request });
    const payload = await buildSessionPayload();
    return NextResponse.json({ ok: true, ...payload });
  } catch (error) {
    return errorResponse(error);
  }
}
