/**
 * Safepay integration (Pakistan).
 *
 * Endpoints and flows follow Safepay's published API:
 *   • merchant API key + secret            https://getsafepay.pk/
 *   • order tracker                        POST {api}/order/v1/init
 *   • passport (time-based token)          POST {api}/client/passport/v1/token
 *   • hosted checkout                      GET  {checkout}/embedded?tracker=…
 *   • native subscription checkout         GET  {checkout}/checkout/subscribe?plan_id=…
 *   • payment lookup (server-side verify)  GET  {api}/reporter/api/v2/payments/{tracker}
 *   • subscription cancel                  POST {api}/client/subscriptions/v1/{id}/cancel
 *   • webhook signature                    X-SFPY-SIGNATURE = HMAC-SHA512(webhook_secret, raw body)
 *   • redirect signature                   sig = HMAC-SHA256(v1_secret, tracker)
 *
 * Every call happens on the server. The browser only receives the hosted
 * checkout URL, which is where card details are entered and tokenised by
 * Safepay — raw card data never reaches this application.
 */
import { config } from "../config";
import { hmacHex, safeEqualStrings } from "../crypto";
import {
  ProviderError,
  type PaymentProvider,
  type ProviderCheckout,
  type ProviderCheckoutInput,
  type ProviderPaymentState,
} from "./provider";

type SafepayJson = Record<string, unknown>;

async function safepayRequest(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ status: number; body: SafepayJson | null; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);
  try {
    const response = await fetch(`${config.safepay.apiBase}${path}`, {
      method: init.method ?? "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-SFPY-MERCHANT-SECRET": config.safepay.secretKey,
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    let body: SafepayJson | null = null;
    try {
      body = text ? (JSON.parse(text) as SafepayJson) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

function pickString(source: unknown, ...keys: string[]): string | null {
  if (!source || typeof source !== "object") return null;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Safepay returns amounts as decimal strings in currency units ("1500.00"). */
function parseMajorToMinor(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 100);
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) return Math.round(Number(value) * 100);
  return null;
}

export class SafepayProvider implements PaymentProvider {
  readonly id = "safepay";
  readonly label = "Safepay";

  isConfigured(): boolean {
    return Boolean(config.safepay.secretKey && config.safepay.apiKey);
  }

  unavailableReason(): string | null {
    if (!this.isConfigured()) {
      return "Card payments are not switched on yet. SAFEPAY_API_KEY and SAFEPAY_SECRET_KEY must be configured on the server.";
    }
    return null;
  }

  /** Creates an order tracker. Falls back to the v3 endpoint if v1 is unavailable. */
  private async createTracker(input: ProviderCheckoutInput): Promise<string> {
    const amountMajor = input.amountMinor / 100;
    const legacy = await safepayRequest("/order/v1/init", {
      body: {
        environment: config.safepay.environment,
        client: config.safepay.apiKey,
        amount: amountMajor,
        currency: input.currency,
        order_id: input.paymentId,
      },
    });
    const legacyToken =
      pickString(legacy.body, "token") ??
      pickString((legacy.body?.data as SafepayJson | undefined) ?? null, "token", "tracker");
    if (legacy.status < 300 && legacyToken) return legacyToken;

    // Safepay's v3 session endpoint authenticates with the merchant secret and
    // expects the amount in the currency's lowest denomination.
    const v3 = await safepayRequest("/order/payments/v3/", {
      body: {
        merchant_api_key: config.safepay.apiKey,
        intent: "CYBERSOURCE",
        mode: "payment",
        currency: input.currency,
        amount: input.amountMinor,
        metadata: { order_id: input.paymentId, reference: input.subscriptionId },
      },
    });
    const v3Token =
      pickString(v3.body, "token") ??
      pickString((v3.body?.data as SafepayJson | undefined) ?? null, "token", "tracker");
    if (v3.status < 300 && v3Token) return v3Token;

    throw new ProviderError(
      `Safepay did not create a payment session (v1 ${legacy.status}: ${legacy.text.slice(0, 160)}; v3 ${v3.status}: ${v3.text.slice(0, 160)})`,
      this.id,
    );
  }

  /** Time-based token used by the hosted checkout and the subscribe page. */
  private async createPassport(): Promise<string | null> {
    const response = await safepayRequest("/client/passport/v1/token", { body: {} });
    if (response.status >= 300) return null;
    return (
      pickString(response.body, "data", "token") ??
      pickString((response.body?.data as SafepayJson | undefined) ?? null, "token") ??
      null
    );
  }

  async createCheckout(input: ProviderCheckoutInput): Promise<ProviderCheckout> {
    if (!this.isConfigured()) throw new ProviderError("Safepay is not configured", this.id);
    const environment = config.safepay.environment;
    const base = config.safepay.checkoutBase;

    // Native recurring subscription: Safepay collects and re-charges the card
    // against a plan created in the merchant dashboard.
    if (input.billingMode === "recurring" && input.providerPlanId) {
      const tbt = await this.createPassport();
      if (!tbt) {
        throw new ProviderError("Safepay did not issue a checkout token for the subscription", this.id);
      }
      const url = new URL(`${base}/checkout/subscribe`);
      url.searchParams.set("env", environment);
      url.searchParams.set("plan_id", input.providerPlanId);
      url.searchParams.set("auth_token", tbt);
      url.searchParams.set("cancel_url", input.cancelUrl);
      url.searchParams.set("redirect_url", input.returnUrl);
      url.searchParams.set("reference", input.subscriptionId);
      return { redirectUrl: url.toString(), providerPaymentId: null, providerSubscriptionId: null };
    }

    // One-time hosted checkout (the supported flow until Safepay approves
    // recurring billing for the merchant account).
    const tracker = await this.createTracker(input);
    const tbt = await this.createPassport();
    const url = new URL(`${base}/embedded`);
    url.searchParams.set("environment", environment);
    url.searchParams.set("tracker", tracker);
    url.searchParams.set("source", "custom");
    if (tbt) url.searchParams.set("tbt", tbt);
    url.searchParams.set("redirect_url", input.returnUrl);
    url.searchParams.set("cancel_url", input.cancelUrl);
    url.searchParams.set("order_id", input.paymentId);
    if (input.customer.email) url.searchParams.set("email", input.customer.email);

    return { redirectUrl: url.toString(), providerPaymentId: tracker, providerSubscriptionId: null };
  }

  async fetchPayment(providerPaymentId: string): Promise<ProviderPaymentState> {
    const tracker = encodeURIComponent(providerPaymentId);
    const response = await safepayRequest(`/reporter/api/v2/payments/${tracker}`, { method: "GET" });
    if (response.status === 404) {
      // Legacy tracker lookup.
      const legacy = await safepayRequest(`/order/v1/payments/${tracker}`, { method: "GET" });
      if (legacy.status >= 300) return { state: "unknown", reason: `Safepay lookup failed (${legacy.status})` };
      return this.normalizeState(legacy.body, legacy.body);
    }
    if (response.status >= 300) {
      return { state: "unknown", reason: `Safepay lookup failed (${response.status})` };
    }
    const data = (response.body?.data as SafepayJson | undefined) ?? response.body;
    return this.normalizeState(data, response.body);
  }

  private normalizeState(data: SafepayJson | null, envelope: SafepayJson | null): ProviderPaymentState {
    const stateSource = data ?? {};
    const state = (
      pickString(stateSource, "state", "status") ??
      pickString(envelope, "state", "status") ??
      ""
    ).toUpperCase();
    const amountMinor = parseMajorToMinor(stateSource.amount);
    const currency = pickString(stateSource, "currency");
    const reference = pickString(stateSource, "reference", "ref", "tracker");
    if (["PAID", "CAPTURED", "SUCCEEDED", "COMPLETED", "SETTLED"].includes(state)) {
      return { state: "paid", amountMinor, currency, reference };
    }
    if (["REFUNDED", "PARTIALLY_REFUNDED"].includes(state)) {
      return { state: "refunded", amountMinor };
    }
    if (["FAILED", "DECLINED", "ERROR", "CANCELLED", "CANCELED", "VOIDED", "EXPIRED"].includes(state)) {
      return { state: "failed", reason: pickString(stateSource, "reason", "message") ?? state };
    }
    if (["CREATED", "PENDING", "AUTHORIZED", "REQUIRES_ACTION", "INITIATED", "PROCESSING"].includes(state)) {
      return { state: "pending" };
    }
    return { state: "unknown", reason: state || "No payment state returned" };
  }

  /**
   * Webhook authenticity: HMAC-SHA512 over the exact raw request body, keyed
   * with the webhook secret from the Safepay dashboard.
   */
  verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
    if (!config.safepay.webhookSecret || !signature) return false;
    const expected = hmacHex(config.safepay.webhookSecret, rawBody, "sha512");
    return safeEqualStrings(expected, signature.trim().toLowerCase());
  }

  /** Redirect authenticity: sig = HMAC-SHA256(api secret, tracker). */
  verifyReturnSignature(providerPaymentId: string, signature: string | null): boolean {
    if (!signature) return false;
    const secret = config.safepay.v1Secret || config.safepay.secretKey;
    if (!secret) return false;
    const expected = hmacHex(secret, providerPaymentId, "sha256");
    return safeEqualStrings(expected.toLowerCase(), signature.trim().toLowerCase());
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    const response = await safepayRequest(
      `/client/subscriptions/v1/${encodeURIComponent(providerSubscriptionId)}/cancel`,
      { body: {} },
    );
    return response.status < 300;
  }
}

export const safepayProvider = new SafepayProvider();
