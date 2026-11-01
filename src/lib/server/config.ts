/**
 * Server-side configuration.
 *
 * Everything secret is read from the environment on the server only. Nothing in
 * this module may be imported from a client component: the payment keys, the
 * storage signing secret and the mail credentials must never reach the browser.
 */

function str(value: string | undefined, fallback = ""): string {
  return (value ?? fallback).trim();
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function list(value: string | undefined): string[] {
  return str(value)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

const emailTransportRaw = str(process.env.EMAIL_TRANSPORT, "").toLowerCase();
const smtpConfigured = Boolean(process.env.SMTP_URL || (process.env.SMTP_HOST && process.env.SMTP_USER));
const resendConfigured = Boolean(process.env.RESEND_API_KEY);

/**
 * Email transport resolution order:
 *   explicit EMAIL_TRANSPORT → SMTP when configured → Resend when configured → console outbox.
 * The console transport still writes every message to the `email_outbox` table
 * so links are recoverable from the admin dashboard during setup.
 */
const emailTransport: "smtp" | "resend" | "console" =
  emailTransportRaw === "smtp" || emailTransportRaw === "resend" || emailTransportRaw === "console"
    ? (emailTransportRaw as "smtp" | "resend" | "console")
    : smtpConfigured
      ? "smtp"
      : resendConfigured
        ? "resend"
        : "console";

const appUrl = str(process.env.APP_URL, "").replace(/\/+$/, "");

export const config = {
  isProduction: process.env.NODE_ENV === "production",
  /** Public origin used to build links in emails and payment redirects. */
  appUrl,

  auth: {
    /** Session lifetime in days; sliding for active users. */
    sessionDays: int(process.env.AUTH_SESSION_DAYS, 30),
    sessionRefreshWindowDays: 7,
    verifyTokenHours: int(process.env.AUTH_VERIFY_TOKEN_HOURS, 48),
    resetTokenMinutes: int(process.env.AUTH_RESET_TOKEN_MINUTES, 60),
    /** Expose verification/reset links in API responses. Only honoured on the console transport. */
    exposeDevLinks: bool(process.env.AUTH_EXPOSE_DEV_LINKS, emailTransport === "console" && process.env.NODE_ENV !== "production"),
  },

  email: {
    transport: emailTransport,
    from: str(process.env.EMAIL_FROM, "PDF Pro <no-reply@pdfpro.local>"),
    smtpUrl: str(process.env.SMTP_URL),
    smtpHost: str(process.env.SMTP_HOST),
    smtpPort: int(process.env.SMTP_PORT, 587),
    smtpSecure: bool(process.env.SMTP_SECURE, false),
    smtpUser: str(process.env.SMTP_USER),
    smtpPass: str(process.env.SMTP_PASS),
    resendKey: str(process.env.RESEND_API_KEY),
  },

  google: {
    clientId: str(process.env.GOOGLE_CLIENT_ID),
    clientSecret: str(process.env.GOOGLE_CLIENT_SECRET),
  },

  storage: {
    /**
     * `local` (private directory) or `s3` (any S3-compatible bucket, including
     * Neon Object Storage, Cloudflare R2, AWS S3 and MinIO).
     */
    driver: (str(process.env.STORAGE_DRIVER, "local").toLowerCase() === "s3" ? "s3" : "local") as "local" | "s3",
    dir: str(process.env.STORAGE_DIR, ".data/storage"),
    /** HMAC secret for temporary signed download URLs. Falls back to a derived secret. */
    signingSecret: str(process.env.STORAGE_SIGNING_SECRET, str(process.env.AUTH_SECRET, "pdfpro-development-signing-secret")),
    signedUrlTtlSeconds: int(process.env.STORAGE_SIGNED_URL_TTL, 300),
    maxUploadBytes: int(process.env.STORAGE_MAX_UPLOAD_BYTES, 100 * 1024 * 1024),
  },

  safepay: {
    environment: (str(process.env.SAFEPAY_ENV, "sandbox").toLowerCase() === "production" ? "production" : "sandbox") as
      | "sandbox"
      | "production",
    /** Secret key (`sec_…`) used as X-SFPY-MERCHANT-SECRET. */
    secretKey: str(process.env.SAFEPAY_SECRET_KEY),
    /** Public merchant API key (`sec_…`) used as `client` / `merchant_api_key`. */
    apiKey: str(process.env.SAFEPAY_API_KEY),
    /** Webhook signing secret (HMAC-SHA512 over the raw body). */
    webhookSecret: str(process.env.SAFEPAY_WEBHOOK_SECRET),
    /** v1 secret used to validate the POST Safepay makes to the redirect URL. */
    v1Secret: str(process.env.SAFEPAY_V1_SECRET),
    apiBase: str(
      process.env.SAFEPAY_API_BASE,
      str(process.env.SAFEPAY_ENV, "sandbox").toLowerCase() === "production"
        ? "https://api.getsafepay.com"
        : "https://sandbox.api.getsafepay.com",
    ).replace(/\/+$/, ""),
    /** Hosted checkout/subscribe pages. */
    checkoutBase: str(
      process.env.SAFEPAY_CHECKOUT_BASE,
      str(process.env.SAFEPAY_ENV, "sandbox").toLowerCase() === "production"
        ? "https://getsafepay.com"
        : "https://sandbox.api.getsafepay.com",
    ).replace(/\/+$/, ""),
  },

  billing: {
    graceDays: int(process.env.BILLING_GRACE_DAYS, 3),
    /** Kill-switch for checkout while merchant onboarding is in progress. */
    disabled: bool(process.env.BILLING_DISABLED, false),
  },

  adsense: {
    publisherId: str(process.env.ADSENSE_CLIENT_ID, process.env.NEXT_PUBLIC_ADSENSE_CLIENT_ID),
    enabled: bool(process.env.ADSENSE_ENABLED, false),
    slots: {
      dashboard: str(process.env.ADSENSE_SLOT_DASHBOARD),
      cloud: str(process.env.ADSENSE_SLOT_CLOUD),
      tools: str(process.env.ADSENSE_SLOT_TOOLS),
      pricing: str(process.env.ADSENSE_SLOT_PRICING),
    },
  },

  admin: {
    /** Comma-separated bootstrap administrator emails (verified accounts only). */
    emails: list(process.env.ADMIN_EMAILS),
  },

  maintenance: {
    cronSecret: str(process.env.CRON_SECRET),
  },

  rateLimit: {
    /** Shared secret pepper for hashing IPs in the session table. */
    pepper: str(process.env.AUTH_SECRET, "pdfpro-development-pepper"),
  },
} as const;

export type AppConfig = typeof config;

/** True when Safepay can create checkouts (all required credentials present). */
export function safepayConfigured(): boolean {
  return Boolean(config.safepay.secretKey && config.safepay.apiKey);
}

/** True when Google sign-in can be offered. */
export function googleConfigured(): boolean {
  return Boolean(config.google.clientId && config.google.clientSecret);
}

/** Absolute application URL, falling back to the incoming request origin. */
export function resolveAppUrl(request?: Request): string {
  if (config.appUrl) return config.appUrl;
  if (request) {
    const url = new URL(request.url);
    const forwardedHost = request.headers.get("x-forwarded-host");
    const forwardedProto = request.headers.get("x-forwarded-proto");
    if (forwardedHost) {
      return `${forwardedProto ?? url.protocol.replace(":", "")}://${forwardedHost}`;
    }
    return url.origin;
  }
  return "http://localhost:3000";
}
