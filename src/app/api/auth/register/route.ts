import { NextResponse } from "next/server";
import { assertSameOrigin, clientIp, errorResponse, hashIp, readJson } from "@/lib/server/api";
import { registerUser } from "@/lib/server/auth";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { buildSessionPayload } from "@/lib/server/session-payload";
import { requireTurnstile } from "@/lib/server/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await enforceRateLimit(`register:ip:${hashIp(clientIp(request))}`, 8, 3600);
    const body = await readJson<{
      email?: string;
      password?: string;
      displayName?: string;
      marketingOptIn?: boolean;
      turnstileToken?: string;
    }>(request);
    await enforceRateLimit(`register:email:${(body.email ?? "").toLowerCase().slice(0, 200)}`, 5, 3600);
    await requireTurnstile(request, body.turnstileToken);

    const result = await registerUser({
      email: String(body.email ?? ""),
      password: String(body.password ?? ""),
      displayName: body.displayName ? String(body.displayName) : undefined,
      marketingOptIn: Boolean(body.marketingOptIn),
      request,
    });

    const payload = await buildSessionPayload();
    return NextResponse.json(
      {
        ok: true,
        verificationSent: result.emailDelivered,
        emailTransport: result.emailTransport,
        ...(result.verificationPreviewUrl ? { previewUrl: result.verificationPreviewUrl } : {}),
        ...payload,
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
