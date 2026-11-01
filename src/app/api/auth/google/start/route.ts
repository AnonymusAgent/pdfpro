import { NextResponse, type NextRequest } from "next/server";
import { googleConfigured, resolveAppUrl } from "@/lib/server/config";
import { base64url, randomToken, sha256Hex } from "@/lib/server/crypto";
import { buildGoogleAuthUrl, googleRedirectUri } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OAUTH_COOKIE = "pdfpro_oauth";

export async function GET(request: NextRequest) {
  const origin = resolveAppUrl(request);
  if (!googleConfigured()) {
    return NextResponse.redirect(`${origin}/login?error=google_unavailable`);
  }

  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = base64url(sha256Hex(verifier));
  const nextParam = request.nextUrl.searchParams.get("next") ?? "/dashboard";
  const safeNext = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/dashboard";

  const response = NextResponse.redirect(
    buildGoogleAuthUrl({
      state,
      codeChallenge: challenge,
      redirectUri: googleRedirectUri(request),
      loginHint: request.nextUrl.searchParams.get("email") ?? undefined,
    }),
  );
  response.cookies.set({
    name: OAUTH_COOKIE,
    value: base64url(JSON.stringify({ state, verifier, next: safeNext, at: Date.now() })),
    httpOnly: true,
    secure: origin.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return response;
}

export { OAUTH_COOKIE };
