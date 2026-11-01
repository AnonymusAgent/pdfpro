/**
 * Payment provider contract.
 *
 * The billing service talks to providers only through this interface, so a
 * second gateway (for example Stripe for a merchant in a supported country)
 * can be added without touching subscription logic. Providers must:
 *
 *   - create a hosted checkout (card data never touches this application),
 *   - verify webhooks cryptographically on the server,
 *   - expose a server-to-server payment lookup so activation never depends on
 *     a browser redirect.
 */
export type ProviderCheckoutInput = {
  /** Our payment row id — used as the provider's order reference. */
  paymentId: string;
  /** Our subscription row id — returned by the provider on subscription webhooks. */
  subscriptionId: string;
  /** Plan price in the currency's minor unit (paisa/cents). */
  amountMinor: number;
  currency: string;
  interval: "month" | "year";
  billingMode: "recurring" | "one_time";
  /** Provider plan id for native recurring subscriptions, when configured. */
  providerPlanId: string | null;
  customer: { id: string; email: string; name: string | null };
  returnUrl: string;
  cancelUrl: string;
};

export type ProviderCheckout = {
  redirectUrl: string;
  providerPaymentId: string | null;
  providerSubscriptionId: string | null;
};

export type ProviderPaymentState =
  | { state: "paid"; amountMinor: number | null; currency: string | null; reference: string | null }
  | { state: "failed"; reason: string | null }
  | { state: "pending" }
  | { state: "refunded"; amountMinor: number | null }
  | { state: "unknown"; reason: string | null };

export interface PaymentProvider {
  readonly id: string;
  readonly label: string;
  /** True only when every credential needed for a live checkout is present. */
  isConfigured(): boolean;
  /** Human-readable reason shown in the UI when checkout is unavailable. */
  unavailableReason(): string | null;
  createCheckout(input: ProviderCheckoutInput): Promise<ProviderCheckout>;
  /** Server-side status lookup (never trusts the browser). */
  fetchPayment(providerPaymentId: string): Promise<ProviderPaymentState>;
  verifyWebhookSignature(rawBody: string, signature: string | null): boolean;
  /** Validates the POST Safepay/OAuth-style redirect back to our return URL. */
  verifyReturnSignature?(providerPaymentId: string, signature: string | null): boolean;
  cancelSubscription(providerSubscriptionId: string): Promise<boolean>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly provider: string, readonly cause?: unknown) {
    super(message);
  }
}
