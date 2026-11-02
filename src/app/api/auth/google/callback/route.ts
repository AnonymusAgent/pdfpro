import { NextResponse, type NextRequest } from "next/server";
import { googleConfigured, resolveAppUrl } from "@/lib/server/config";
import { HttpError } from "@/lib/server/api";
import { exchangeGoogleCode, googleRedirectUri, signInWithGoogle } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OAUTH_COOKIE = "pdfpro_oauth";

export async function GET(request: NextRequest) {
  const origin = resolveAppUrl(request);
  const fail = (reason: string) => {
    const response = NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(reason)}`);
    response.cookies.set({ name: OAUTH_COOKIE, value: "", path: "/", maxAge: 0 });
    return response;
  };

  if (!googleConfigured()) return fail("google_unavailable");

  const cookie = request.cookies.get(OAUTH_COOKIE)?.value;
  if (!cookie) return fail("oauth_state_missing");
  let state: { state?: string; verifier?: string; next?: string; at?: number };
  try {
    state = JSON.parse(Buffer.from(cookie, "base64url").toString("utf8")) as typeof state;
  } catch {
    return fail("oauth_state_invalid");
  }
  if (!state.at || Date.now() - state.at > 10 * 60 * 1000) return fail("oauth_state_expired");

  const error = request.nextUrl.searchParams.get("error");
  if (error) return fail(error === "access_denied" ? "google_cancelled" : "google_failed");

  const code = request.nextUrl.searchParams.get("code");
  const returnedState = request.nextUrl.searchParams.get("state");
  if (!code || !returnedState || returnedState !== state.state || !state.verifier) {
    return fail("oauth_state_mismatch");
  }

  try {
    const profile = await exchangeGoogleCode({
      code,
      codeVerifier: state.verifier,
      redirectUri: googleRedirectUri(request),
    });
    await signInWithGoogle({ profile, request });
  } catch (exchangeError) {
    if (exchangeError instanceof HttpError && (exchangeError.code === "registration_closed" || exchangeError.code === "admin_password_required")) {
      return fail(exchangeError.code);
    }
    console.error("[auth] google sign-in failed", exchangeError);
    return fail("google_failed");
  }

  const next = state.next && state.next.startsWith("/") && !state.next.startsWith("//") ? state.next : "/dashboard";
  const response = NextResponse.redirect(`${origin}${next}`);
  response.cookies.set({ name: OAUTH_COOKIE, value: "", path: "/", maxAge: 0 });
  return response;
}
