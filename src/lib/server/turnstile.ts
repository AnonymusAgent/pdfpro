/**
 * Cloudflare Turnstile — human verification for the unauthenticated auth routes.
 *
 * The widget runs in the browser and hands out a single-use token; only Cloudflare
 * can validate that token, so the check is always performed server-side against
 * `siteverify` with the secret key. Design rules:
 *
 * - **Disabled means disabled.** Without both keys nothing is rendered and nothing
 *   is checked, so local development, CI and a deployment that has not been
 *   registered with Cloudflare all keep working.
 * - **Fail closed.** If `siteverify` is unreachable or answers with a non-2xx the
 *   request is rejected with `503 turnstile_unavailable` instead of being let
 *   through: a captcha that silently stops working is worse than a retry prompt.
 * - **Hostname is checked.** A token minted for another site is not accepted.
 * - The secret key never leaves the server; the site key is public by design.
 */
import { HttpError, clientIp } from "./api";
import { config } from "./config";

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type TurnstileResult =
  | { ok: true; skipped: boolean }
  | { ok: false; status: number; code: string; message: string; details?: Record<string, unknown> };

export type VerifyTurnstileInput = {
  /** Token from the widget (`cf-turnstile-response`). */
  token?: string | null;
  /** Visitor IP, forwarded to Cloudflare to help its risk analysis. */
  remoteIp?: string | null;
  /** Hostname the widget was served from; compared with Cloudflare's answer. */
  expectedHost?: string | null;
  /** Overrides for tests; default to the deployment configuration. */
  secretKey?: string;
  siteKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

/** Strip the port and lower-case a host header value. */
export function normalizeHost(value: string | null | undefined): string {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return "";
  const withoutPort = raw.replace(/:\d+$/, "");
  return withoutPort.replace(/^www\./, "");
}

/** Host the request was served for, honouring a reverse proxy. */
export function requestHost(request: Request): string {
  return normalizeHost(request.headers.get("x-forwarded-host") ?? request.headers.get("host"));
}

function unavailable(): TurnstileResult {
  return {
    ok: false,
    status: 503,
    code: "turnstile_unavailable",
    message: "Human verification is temporarily unavailable. Please try again in a moment.",
  };
}

/**
 * Validate a Turnstile token. Returns `{ ok: true, skipped: true }` when the
 * deployment has no keys, so callers can call this unconditionally.
 */
export async function verifyTurnstile(input: VerifyTurnstileInput): Promise<TurnstileResult> {
  const secretKey = (input.secretKey ?? config.cloudflare.turnstileSecretKey).trim();
  const siteKey = (input.siteKey ?? config.cloudflare.turnstileSiteKey).trim();
  if (!secretKey || !siteKey) return { ok: true, skipped: true };

  const token = (input.token ?? "").trim();
  if (!token) {
    return {
      ok: false,
      status: 400,
      code: "turnstile_required",
      message: "Please complete the human verification check before continuing.",
    };
  }
  if (token.length > 4096) {
    return { ok: false, status: 400, code: "turnstile_required", message: "The verification token is malformed." };
  }

  const form = new URLSearchParams({ secret: secretKey, response: token });
  if (input.remoteIp) form.set("remoteip", input.remoteIp);

  let payload: { success?: boolean; "error-codes"?: string[]; hostname?: string; challenge_ts?: string };
  try {
    const response = await (input.fetchImpl ?? fetch)(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(input.timeoutMs ?? 6000),
      cache: "no-store",
    });
    if (!response.ok) return unavailable();
    payload = (await response.json()) as typeof payload;
  } catch {
    return unavailable();
  }

  if (payload.success !== true) {
    return {
      ok: false,
      status: 403,
      code: "turnstile_failed",
      message: "Human verification failed. Please complete the check again.",
      details: { reason: payload["error-codes"] ?? [] },
    };
  }

  const expected = normalizeHost(input.expectedHost);
  const answered = normalizeHost(payload.hostname);
  if (expected && answered && expected !== answered) {
    return {
      ok: false,
      status: 403,
      code: "turnstile_hostname_mismatch",
      message: "Human verification was issued for a different site. Please reload and try again.",
    };
  }

  return { ok: true, skipped: false };
}

/**
 * Route helper: verifies the token carried in the JSON body and throws an
 * `HttpError` the standard error handler can serialise. No-op when Turnstile is
 * not configured.
 */
export async function requireTurnstile(request: Request, token?: string | null): Promise<void> {
  const result = await verifyTurnstile({
    token,
    remoteIp: clientIp(request),
    expectedHost: requestHost(request),
  });
  if (!result.ok) throw new HttpError(result.status, result.message, result.code, result.details);
}
