/**
 * Server-side error helpers and request guards.
 *
 * Every mutating API route calls `assertSameOrigin` and the relevant rate
 * limiter before touching the database.
 */
import { config } from "./config";
import { sha256Hex } from "./crypto";

export class HttpError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(status: number, message: string, code = "error", details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json(
      { error: error.message, code: error.code, ...(error.details ?? {}) },
      { status: error.status },
    );
  }
  console.error("[api] unhandled error", error);
  return Response.json({ error: "Something went wrong. Please try again.", code: "internal_error" }, { status: 500 });
}

export async function readJson<T = Record<string, unknown>>(request: Request, maxBytes = 64 * 1024): Promise<T> {
  const raw = await request.text();
  if (raw.length > maxBytes) throw new HttpError(413, "Request body is too large.", "payload_too_large");
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, "Request body must be JSON.", "invalid_json");
  }
}

/**
 * CSRF defence for cookie-authenticated mutations: the Origin (or Referer) must
 * match the host that served the request. Combined with SameSite=Lax session
 * cookies this blocks cross-site form posts and fetch calls.
 */
export function assertSameOrigin(request: Request): void {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  const origin = request.headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new HttpError(403, "Invalid request origin.", "bad_origin");
    }
    if (!host || originHost !== host) {
      throw new HttpError(403, "Cross-site request blocked.", "bad_origin");
    }
    return;
  }

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      if (!host || new URL(referer).host !== host) {
        throw new HttpError(403, "Cross-site request blocked.", "bad_origin");
      }
      return;
    } catch {
      throw new HttpError(403, "Cross-site request blocked.", "bad_origin");
    }
  }

  // No Origin/Referer: browsers always send one for cross-site POSTs. Non-browser
  // clients (webhooks, cron) are protected by signature/secret checks instead.
  if (config.isProduction) {
    throw new HttpError(403, "Missing request origin.", "missing_origin");
  }
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "127.0.0.1";
}

/** IPs are stored only as a salted hash — enough for "same network" hints. */
export function hashIp(ip: string): string {
  return sha256Hex(`${config.rateLimit.pepper}:${ip}`);
}

export function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const ua = userAgent.toLowerCase();
  const browser = ua.includes("edg/")
    ? "Edge"
    : ua.includes("chrome") && !ua.includes("chromium")
      ? "Chrome"
      : ua.includes("firefox")
        ? "Firefox"
        : ua.includes("safari")
          ? "Safari"
          : "Browser";
  const os = ua.includes("iphone")
    ? "iPhone"
    : ua.includes("ipad")
      ? "iPad"
      : ua.includes("android")
        ? "Android"
        : ua.includes("mac os")
          ? "macOS"
          : ua.includes("windows")
            ? "Windows"
            : ua.includes("linux")
              ? "Linux"
              : "Unknown OS";
  return `${browser} · ${os}`;
}
