/**
 * Small HTTP client + database helpers for the integration tests.
 *
 * The client keeps its own cookie jar and always sends an Origin header, since
 * every mutating API route enforces same-origin requests.
 */
import { createHmac, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { Pool } from "pg";
import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";

export const BASE_URL = process.env.IT_BASE_URL ?? "http://127.0.0.1:3300";
export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  // The embedded development database caps its connection count, so the test
  // harness stays deliberately small and fails fast instead of hanging.
  max: 3,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 5_000,
});

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly path: string,
  ) {
    super(`${path} → ${status}: ${JSON.stringify(body)}`);
  }
}

export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

export class Client {
  private cookies = new Map<string, string>();

  constructor(readonly label = "client") {}

  get cookieHeader(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  hasCookie(name: string): boolean {
    return this.cookies.has(name);
  }

  private absorb(response: Response): void {
    const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      if (index === -1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = /max-age=0|expires=thu, 01 jan 1970/i.test(raw);
      if (!value || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request<T = Record<string, unknown>>(
    path: string,
    init: RequestInit & { json?: unknown; form?: FormData; omitOrigin?: boolean } = {},
  ): Promise<ApiResponse<T>> {
    const headers = new Headers(init.headers);
    if (!init.omitOrigin && !headers.has("origin")) headers.set("Origin", BASE_URL);
    if (this.cookies.size) headers.set("Cookie", this.cookieHeader);
    let body = init.body;
    if (init.json !== undefined && !["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase())) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(init.json);
    }
    if (init.form) body = init.form;

    const response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers,
      body,
      redirect: init.redirect ?? "manual",
    });
    this.absorb(response);

    const contentType = response.headers.get("content-type") ?? "";
    const parsed = contentType.includes("application/json")
      ? ((await response.json()) as T)
      : ((await response.text()) as unknown as T);
    return { status: response.status, body: parsed, headers: response.headers };
  }

  async get<T = Record<string, unknown>>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>(path, { method: "GET" });
  }

  async post<T = Record<string, unknown>>(path: string, json?: unknown, init: RequestInit = {}): Promise<ApiResponse<T>> {
    return this.request<T>(path, { ...init, method: "POST", json });
  }

  async patch<T = Record<string, unknown>>(path: string, json?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(path, { method: "PATCH", json });
  }

  async put<T = Record<string, unknown>>(path: string, json?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(path, { method: "PUT", json });
  }

  async del<T = Record<string, unknown>>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>(path, { method: "DELETE" });
  }

  async upload<T = Record<string, unknown>>(bytes: Uint8Array, name = "test-document.pdf"): Promise<ApiResponse<T>> {
    const form = new FormData();
    form.append("file", new File([bytes as BlobPart], name, { type: "application/pdf" }));
    return this.request<T>("/api/files", { method: "POST", form });
  }
}

/** A small, real PDF with extractable text. */
export async function makePdf(text = "Integration test document"): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([420, 595]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 40, y: 520, size: 14, font, color: rgb(0.1, 0.15, 0.25) });
  return new Uint8Array(await pdf.save({ addDefaultPage: false }));
}

export function uniqueEmail(prefix = "it"): string {
  return `${prefix}+${randomBytes(6).toString("hex")}@example.test`;
}

export const PASSWORD = "Integration-Pass1";

/** Seed a verified test account as a trusted operator; public registration is closed. */
export async function createUser(options: { password?: string; displayName?: string; verified?: boolean } = {}): Promise<{
  client: Client;
  email: string;
  password: string;
  userId: string;
}> {
  const email = uniqueEmail();
  const password = options.password ?? PASSWORD;
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 16384 * 8 * 2 });
  const passwordHash = `scrypt$16384$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
  const { rows } = await db.query<{ id: string }>(
    "insert into users (email, email_normalized, password_hash, email_verified_at, display_name) values ($1, $1, $2, $3, $4) returning id",
    [email, passwordHash, options.verified === false ? null : new Date(), options.displayName ?? "Integration Tester"],
  );
  const userId = rows[0]!.id;
  await db.query("insert into profiles (user_id, full_name) values ($1, $2)", [userId, options.displayName ?? "Integration Tester"]);
  await db.query("insert into storage_usage (user_id) values ($1)", [userId]);
  const client = new Client(email);
  const login = await client.post("/api/auth/login", { email, password });
  if (login.status !== 200) throw new HttpError(login.status, login.body, "login");
  return { client, email, password, userId };
}

export function extractToken(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, BASE_URL);
    return parsed.searchParams.get("token");
  } catch {
    return null;
  }
}

export async function resetRateLimits(): Promise<void> {
  await db.query("delete from rate_limits");
}

export async function purgeTestUsers(): Promise<void> {
  await db.query("delete from users where email_normalized like 'it+%@example.test'");
}

export async function grantAdmin(email: string): Promise<void> {
  const { rows } = await db.query<{ id: string }>("select id from users where email_normalized = $1", [email]);
  if (!rows[0]) throw new Error(`No user for ${email}`);
  await db.query(
    `insert into admin_roles (user_id, role, granted_by) values ($1, 'admin', null)
     on conflict (user_id) do update set role = 'admin'`,
    [rows[0].id],
  );
}

export async function revokeAdmin(email: string): Promise<void> {
  await db.query(
    `delete from admin_roles where user_id = (select id from users where email_normalized = $1)`,
    [email],
  );
}

export function signWebhook(body: string, secret = process.env.SAFEPAY_WEBHOOK_SECRET ?? "it-webhook-secret"): string {
  return createHmac("sha512", secret).update(body).digest("hex");
}

/** Creates the pending payment + subscription rows a checkout would create. */
export async function seedPendingCheckout(params: {
  userId: string;
  planId?: string;
  amountMinor?: number;
  currency?: string;
}): Promise<{ paymentId: string; subscriptionId: string; tracker: string }> {
  const planId = params.planId ?? "premium_monthly";
  const { rows: planRows } = await db.query<{ price_minor: string; currency: string; interval: string }>(
    "select price_minor, currency, interval from subscription_plans where id = $1",
    [planId],
  );
  const plan = planRows[0];
  if (!plan) throw new Error(`Unknown plan ${planId}`);
  const amountMinor = params.amountMinor ?? Number(plan.price_minor);
  const currency = params.currency ?? plan.currency;

  const subscriptionId = randomUUID();
  const paymentId = randomUUID();
  const tracker = `track_it_${randomUUID().replace(/-/g, "")}`;

  await db.query(
    `insert into subscriptions (id, user_id, plan_id, status, provider, provider_reference, billing_mode)
     values ($1, $2, $3, 'pending', 'safepay', $4, 'one_time')`,
    [subscriptionId, params.userId, planId, tracker],
  );
  await db.query(
    `insert into payments (id, user_id, subscription_id, plan_id, provider, provider_payment_id, amount_minor, currency, status, metadata)
     values ($1, $2, $3, $4, 'safepay', $5, $6, $7, 'pending', '{"source":"integration-test"}'::jsonb)`,
    [paymentId, params.userId, subscriptionId, planId, tracker, amountMinor, currency],
  );
  return { paymentId, subscriptionId, tracker };
}

export function paymentWebhook(params: {
  tracker: string;
  amountMinor: number;
  currency?: string;
  eventId?: string;
  state?: string;
  orderId?: string;
}): { body: string; eventId: string } {
  const eventId = params.eventId ?? `evt_${randomUUID()}`;
  const body = JSON.stringify({
    token: eventId,
    type: "payment:created",
    notification: {
      tracker: params.tracker,
      state: params.state ?? "PAID",
      amount: (params.amountMinor / 100).toFixed(2),
      currency: params.currency ?? "PKR",
      reference: `ref_${randomUUID().slice(0, 8)}`,
      metadata: params.orderId ? { order_id: params.orderId } : {},
    },
  });
  return { body, eventId };
}
