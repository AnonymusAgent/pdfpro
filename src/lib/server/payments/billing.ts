/**
 * Subscription billing.
 *
 * Rules enforced here:
 *   • Premium is only ever granted by `activatePaidPayment`, which requires a
 *     cryptographically verified webhook or a server-to-server status lookup.
 *   • Amount and currency must match the local payment record.
 *   • Webhook processing is idempotent: duplicate deliveries are recorded once
 *     and never create a second subscription or extend a period twice.
 *   • Expiry or cancellation restores the Free quota but never deletes files.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  paymentWebhookEvents,
  payments,
  subscriptionPlans,
  subscriptions,
  users,
} from "@/db/schema";
import { planStorageLabel } from "@/lib/plans";
import { HttpError } from "../api";
import { config, resolveAppUrl } from "../config";
import { sanitizeText } from "../crypto";
import { getBillingSettings } from "../platform-settings";
import { notifyUser } from "../notify";
import { premiumActivatedEmail, paymentFailedEmail } from "../auth-emails";
import { sendEmail } from "../email";
import { ProviderError, type PaymentProvider } from "./provider";
import { safepayProvider } from "./safepay";

type PlanRow = typeof subscriptionPlans.$inferSelect;
type PaymentRow = typeof payments.$inferSelect;
type SubscriptionRow = typeof subscriptions.$inferSelect;

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

const PROVIDERS: PaymentProvider[] = [safepayProvider];

export function getPaymentProvider(id = "safepay"): PaymentProvider | null {
  return PROVIDERS.find((provider) => provider.id === id) ?? null;
}

export function listProviderStatus() {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    configured: provider.isConfigured(),
    unavailableReason: provider.unavailableReason(),
  }));
}

/* ------------------------------------------------------------------ */
/* Plans                                                               */
/* ------------------------------------------------------------------ */

export function serializePlan(plan: PlanRow) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    interval: plan.interval as "month" | "year",
    priceMinor: plan.priceMinor,
    currency: plan.currency,
    compareAtMinor: plan.compareAtMinor,
    billingMode: plan.billingMode as "one_time" | "recurring",
    providerPlanId: plan.providerPlanId,
    storageBytes: Number(plan.storageBytes),
    features: Array.isArray(plan.features) ? (plan.features as string[]) : [],
    active: plan.active,
    sortOrder: plan.sortOrder,
  };
}

export async function listPlans(includeInactive = false): Promise<PlanRow[]> {
  const rows = await db
    .select()
    .from(subscriptionPlans)
    .where(includeInactive ? sql`true` : eq(subscriptionPlans.active, true))
    .orderBy(subscriptionPlans.sortOrder, subscriptionPlans.priceMinor);
  return rows;
}

/** What the pricing page and checkout validate against. */
export async function getPurchasablePlan(planId: string): Promise<PlanRow> {
  const [plan] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, planId)).limit(1);
  if (!plan || !plan.active) throw new HttpError(404, "That plan is not available.", "plan_unavailable");
  return plan;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function addInterval(from: Date, interval: "month" | "year"): Date {
  const next = new Date(from.getTime());
  if (interval === "year") next.setUTCFullYear(next.getUTCFullYear() + 1);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

function laterOf(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

async function loadUserForNotice(userId: string) {
  const [row] = await db
    .select({ email: users.email, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? { email: null, displayName: null };
}

async function setUserPlanMirror(userId: string, plan: "free" | "premium"): Promise<void> {
  await db.execute(sql`update users set plan = ${plan}, updated_at = now() where id = ${userId} and plan <> ${plan}`);
}

/* ------------------------------------------------------------------ */
/* Checkout                                                            */
/* ------------------------------------------------------------------ */

export type CheckoutResult = { redirectUrl: string; paymentId: string; subscriptionId: string };

export async function createCheckout(params: {
  userId: string;
  userEmail: string;
  userName: string | null;
  planId: string;
  request: Request;
}): Promise<CheckoutResult> {
  const provider = getPaymentProvider("safepay");
  if (!provider) throw new HttpError(503, "Card payments are unavailable.", "provider_unavailable");

  const billing = await getBillingSettings();
  if (billing.paused) {
    throw new HttpError(503, "Checkout is temporarily paused. Please try again later.", "billing_paused");
  }
  if (!provider.isConfigured()) {
    throw new HttpError(503, provider.unavailableReason() ?? "Card payments are not configured.", "provider_unconfigured");
  }

  const plan = await getPurchasablePlan(params.planId);

  // Refuse a second concurrent purchase while a verified subscription is live.
  const [live] = await db
    .select({ id: subscriptions.id, planId: subscriptions.planId })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, params.userId),
        inArray(subscriptions.status, ["active", "past_due"]),
        sql`(${subscriptions.currentPeriodEnd} is null or ${subscriptions.currentPeriodEnd} > now())`,
      ),
    )
    .limit(1);
  if (live) {
    throw new HttpError(
      409,
      "You already have an active Premium subscription. Manage it from Billing instead of checking out again.",
      "already_subscribed",
    );
  }

  const [subscription] = await db
    .insert(subscriptions)
    .values({
      userId: params.userId,
      planId: plan.id,
      provider: provider.id,
      status: "pending",
      billingMode: plan.billingMode,
      providerReference: null,
    })
    .returning();

  const [payment] = await db
    .insert(payments)
    .values({
      userId: params.userId,
      subscriptionId: subscription!.id,
      planId: plan.id,
      provider: provider.id,
      amountMinor: plan.priceMinor,
      currency: plan.currency,
      status: "pending",
      metadata: { planId: plan.id, interval: plan.interval, billingMode: plan.billingMode },
    })
    .returning();

  const origin = resolveAppUrl(params.request);
  let checkout;
  try {
    checkout = await provider.createCheckout({
      paymentId: payment!.id,
      subscriptionId: subscription!.id,
      amountMinor: plan.priceMinor,
      currency: plan.currency,
      interval: plan.interval as "month" | "year",
      billingMode: plan.billingMode as "one_time" | "recurring",
      providerPlanId: plan.providerPlanId,
      customer: { id: params.userId, email: params.userEmail, name: params.userName },
      returnUrl: `${origin}/billing/return?payment=${payment!.id}`,
      cancelUrl: `${origin}/billing/cancelled?payment=${payment!.id}`,
    });
  } catch (error) {
    await db.update(payments).set({ status: "failed", failureReason: "checkout_creation_failed", updatedAt: new Date() }).where(eq(payments.id, payment!.id));
    await db.update(subscriptions).set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() }).where(eq(subscriptions.id, subscription!.id));
    const message =
      error instanceof ProviderError
        ? "The payment page could not be created. This is usually a gateway configuration problem — no money was taken."
        : "The payment page could not be created. No money was taken.";
    console.error("[billing] checkout failed", error);
    throw new HttpError(502, message, "checkout_failed");
  }

  await db
    .update(payments)
    .set({
      providerPaymentId: checkout.providerPaymentId,
      updatedAt: new Date(),
      metadata: { planId: plan.id, interval: plan.interval, billingMode: plan.billingMode },
    })
    .where(eq(payments.id, payment!.id));
  if (checkout.providerSubscriptionId) {
    await db
      .update(subscriptions)
      .set({ providerSubscriptionId: checkout.providerSubscriptionId, updatedAt: new Date() })
      .where(eq(subscriptions.id, subscription!.id));
  }

  return { redirectUrl: checkout.redirectUrl, paymentId: payment!.id, subscriptionId: subscription!.id };
}

/* ------------------------------------------------------------------ */
/* Verified activation                                                 */
/* ------------------------------------------------------------------ */

export type ActivationInput = {
  providerId: string;
  providerPaymentId: string | null;
  providerReference: string | null;
  amountMinor: number | null;
  currency: string | null;
  metadata: Record<string, unknown>;
  subscriptionIdHint: string | null;
  providerSubscriptionId: string | null;
  source: "webhook" | "return_verification" | "admin";
};

export type ActivationOutcome =
  | { status: "activated" | "extended" | "duplicate"; subscriptionId: string; paymentId: string }
  | { status: "amount_mismatch" | "unmatched" | "ignored"; reason: string };

/**
 * Single entry point that can grant Premium. Everything runs in one
 * transaction guarded by an advisory lock so concurrent webhook deliveries
 * cannot activate twice.
 */
export async function activatePaidPayment(input: ActivationInput): Promise<ActivationOutcome> {
  const lockKey = `pay:${input.providerId}:${input.providerPaymentId ?? input.subscriptionIdHint ?? "unknown"}`;

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);

    // 1. Existing local payment row (checkout initiated by this application)?
    let payment: PaymentRow | null = null;
    if (input.providerPaymentId) {
      const [row] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.provider, input.providerId), eq(payments.providerPaymentId, input.providerPaymentId)))
        .limit(1);
      payment = row ?? null;
    }

    if (payment) {
      if (payment.status === "succeeded") {
        return { status: "duplicate" as const, subscriptionId: payment.subscriptionId ?? "", paymentId: payment.id };
      }

      // Amount/currency verification: a verified event that does not match the
      // expected price is recorded but never grants Premium.
      if (input.amountMinor !== null && input.amountMinor !== payment.amountMinor) {
        await tx
          .update(payments)
          .set({
            status: "failed",
            failureReason: `amount_mismatch: expected ${payment.amountMinor} got ${input.amountMinor}`,
            providerReference: input.providerReference,
            updatedAt: new Date(),
          })
          .where(eq(payments.id, payment.id));
        return { status: "amount_mismatch" as const, reason: "The verified amount does not match the plan price." };
      }
      if (input.currency && input.currency.toUpperCase() !== payment.currency.toUpperCase()) {
        await tx
          .update(payments)
          .set({ status: "failed", failureReason: "currency_mismatch", updatedAt: new Date() })
          .where(eq(payments.id, payment.id));
        return { status: "amount_mismatch" as const, reason: "The verified currency does not match the plan price." };
      }

      const plan = payment.planId ? await getPlanInTx(tx, payment.planId) : null;
      const subscription = await activateSubscriptionInTx(tx, {
        userId: payment.userId,
        subscriptionId: payment.subscriptionId,
        plan,
        providerId: input.providerId,
        providerSubscriptionId: input.providerSubscriptionId,
        providerReference: input.providerReference,
        renewal: false,
      });

      await tx
        .update(payments)
        .set({
          status: "succeeded",
          paidAt: new Date(),
          providerReference: input.providerReference,
          subscriptionId: subscription.id,
          metadata: { ...(payment.metadata as Record<string, unknown>), verifiedAt: new Date().toISOString(), source: input.source },
          updatedAt: new Date(),
        })
        .where(eq(payments.id, payment.id));

      return { status: "activated" as const, subscriptionId: subscription.id, paymentId: payment.id };
    }

    // 2. Renewal or recurring charge: match an existing subscription.
    const subscription = await findSubscriptionForEvent(tx, input);
    if (!subscription) {
      return { status: "unmatched" as const, reason: "No local payment or subscription matches this event." };
    }
    const plan = await getPlanInTx(tx, subscription.planId);

    // Guard against replaying the same provider payment id (unique index also enforces this).
    if (input.providerPaymentId) {
      const [duplicate] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(and(eq(payments.provider, input.providerId), eq(payments.providerPaymentId, input.providerPaymentId)))
        .limit(1);
      if (duplicate) {
        return { status: "duplicate" as const, subscriptionId: subscription.id, paymentId: duplicate.id };
      }
    }

    const [created] = await tx
      .insert(payments)
      .values({
        userId: subscription.userId,
        subscriptionId: subscription.id,
        planId: subscription.planId,
        provider: input.providerId,
        providerPaymentId: input.providerPaymentId,
        providerReference: input.providerReference,
        amountMinor: input.amountMinor ?? plan?.priceMinor ?? 0,
        currency: (input.currency ?? plan?.currency ?? "PKR").toUpperCase(),
        status: "succeeded",
        paidAt: new Date(),
        metadata: { ...input.metadata, source: input.source, renewal: true },
      })
      .returning();

    const renewed = await activateSubscriptionInTx(tx, {
      userId: subscription.userId,
      subscriptionId: subscription.id,
      plan,
      providerId: input.providerId,
      providerSubscriptionId: input.providerSubscriptionId,
      providerReference: input.providerReference,
      renewal: true,
    });

    return { status: "extended" as const, subscriptionId: renewed.id, paymentId: created!.id };
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function getPlanInTx(tx: Tx, planId: string): Promise<PlanRow | null> {
  const [plan] = await tx.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, planId)).limit(1);
  return plan ?? null;
}

async function findSubscriptionForEvent(tx: Tx, input: ActivationInput): Promise<SubscriptionRow | null> {
  if (input.subscriptionIdHint) {
    const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.id, input.subscriptionIdHint)).limit(1);
    if (row) return row;
  }
  if (input.providerSubscriptionId) {
    const [row] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(eq(subscriptions.provider, input.providerId), eq(subscriptions.providerSubscriptionId, input.providerSubscriptionId)),
      )
      .limit(1);
    if (row) return row;
  }
  const reference = typeof input.metadata.reference === "string" ? input.metadata.reference : null;
  if (reference) {
    const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.id, reference)).limit(1);
    if (row) return row;
  }
  const orderId = typeof input.metadata.order_id === "string" ? input.metadata.order_id : null;
  if (orderId) {
    const [payment] = await tx.select().from(payments).where(eq(payments.id, orderId)).limit(1);
    if (payment?.subscriptionId) {
      const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.id, payment.subscriptionId)).limit(1);
      if (row) return row;
    }
  }
  return null;
}

async function activateSubscriptionInTx(
  tx: Tx,
  params: {
    userId: string;
    subscriptionId: string | null;
    plan: PlanRow | null;
    providerId: string;
    providerSubscriptionId: string | null;
    providerReference: string | null;
    renewal: boolean;
  },
): Promise<SubscriptionRow> {
  const now = new Date();
  const interval = (params.plan?.interval === "year" ? "year" : "month") as "month" | "year";

  let target: SubscriptionRow | null = null;
  if (params.subscriptionId) {
    const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.id, params.subscriptionId)).limit(1);
    target = row ?? null;
  }
  if (!target && params.plan) {
    const [row] = await tx
      .insert(subscriptions)
      .values({
        userId: params.userId,
        planId: params.plan.id,
        provider: params.providerId,
        status: "active",
        billingMode: params.plan.billingMode as "one_time" | "recurring",
        providerSubscriptionId: params.providerSubscriptionId,
        providerReference: params.providerReference,
        currentPeriodStart: now,
        currentPeriodEnd: addInterval(now, interval),
      })
      .returning();
    target = row!;
  }
  if (!target) throw new HttpError(500, "Could not resolve the subscription being activated.", "subscription_missing");

  const currentEnd = target.currentPeriodEnd && target.currentPeriodEnd.getTime() > now.getTime() ? target.currentPeriodEnd : null;
  const start = params.renewal && currentEnd ? currentEnd : now;
  const end = addInterval(start, interval);

  // A user only ever has one live subscription.
  await tx.execute(sql`
    update subscriptions
    set status = 'cancelled', cancelled_at = now(), current_period_end = now(), updated_at = now()
    where user_id = ${params.userId}
      and id <> ${target.id}
      and status in ('active', 'past_due', 'pending')
  `);

  const [updated] = await tx
    .update(subscriptions)
    .set({
      status: "active",
      billingMode: params.plan?.billingMode ?? target.billingMode,
      provider: params.providerId,
      providerSubscriptionId: params.providerSubscriptionId ?? target.providerSubscriptionId,
      providerReference: params.providerReference ?? target.providerReference,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: false,
      cancelledAt: null,
      graceUntil: null,
      updatedAt: now,
    })
    .where(eq(subscriptions.id, target.id))
    .returning();

  await tx.execute(sql`update users set plan = 'premium', updated_at = now() where id = ${params.userId}`);
  return updated!;
}

/* ------------------------------------------------------------------ */
/* Effects (email / notifications) kept outside the transaction        */
/* ------------------------------------------------------------------ */

export async function announceActivation(outcome: ActivationOutcome, request?: Request): Promise<void> {
  if (outcome.status !== "activated" && outcome.status !== "extended") return;
  const [sub] = await db
    .select({ sub: subscriptions, plan: subscriptionPlans })
    .from(subscriptions)
    .leftJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.planId))
    .where(eq(subscriptions.id, outcome.subscriptionId))
    .limit(1);
  if (!sub) return;
  const user = await loadUserForNotice(sub.sub.userId);
  if (!user.email) return;

  const periodEnd = sub.sub.currentPeriodEnd;
  await notifyUser({
    userId: sub.sub.userId,
    kind: outcome.status === "extended" ? "subscription_renewed" : "subscription_activated",
    title: outcome.status === "extended" ? "Premium renewed" : "Premium activated",
    body: `${sub.plan?.name ?? "Premium"} is active${periodEnd ? ` until ${periodEnd.toUTCString()}` : ""}. You have ${planStorageLabel(config.plans.premiumStorageBytes)} of storage and no advertisements.`,
    email: user.email,
    displayName: user.displayName,
    sendEmailCopy: false,
    request,
  });
  if (user.email) {
    const template = premiumActivatedEmail({
      displayName: user.displayName,
      planName: sub.plan?.name ?? "Premium",
      periodEnd,
      dashboardUrl: `${resolveAppUrl(request)}/dashboard`,
    });
    await sendEmail({ to: user.email, kind: "premium_activated", ...template });
  }
}

export async function applyPaymentFailure(params: {
  providerId: string;
  providerPaymentId: string | null;
  reason: string | null;
  subscriptionIdHint?: string | null;
  request?: Request;
}): Promise<{ handled: boolean }> {
  const billing = await getBillingSettings();
  const graceUntil = billing.graceDays > 0 ? new Date(Date.now() + billing.graceDays * 86_400_000) : null;

  let userId: string | null = null;
  let planName = "Premium";
  let subscriptionId: string | null = params.subscriptionIdHint ?? null;

  if (params.providerPaymentId) {
    const [payment] = await db
      .select()
      .from(payments)
      .where(and(eq(payments.provider, params.providerId), eq(payments.providerPaymentId, params.providerPaymentId)))
      .limit(1);
    if (payment) {
      await db
        .update(payments)
        .set({ status: "failed", failureReason: params.reason?.slice(0, 300) ?? "payment_failed", updatedAt: new Date() })
        .where(eq(payments.id, payment.id));
      userId = payment.userId;
      subscriptionId = payment.subscriptionId ?? subscriptionId;
    }
  }
  if (!userId && subscriptionId) {
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).limit(1);
    userId = sub?.userId ?? null;
  }
  if (!userId) return { handled: false };

  if (subscriptionId) {
    const [sub] = await db
      .select({ sub: subscriptions, plan: subscriptionPlans })
      .from(subscriptions)
      .leftJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.planId))
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    if (sub) {
      planName = sub.plan?.name ?? planName;
      if (graceUntil) {
        await db
          .update(subscriptions)
          .set({ status: "past_due", graceUntil, updatedAt: new Date() })
          .where(eq(subscriptions.id, subscriptionId));
        // During grace the user keeps Premium benefits.
        await setUserPlanMirror(userId, "premium");
      } else {
        await db
          .update(subscriptions)
          .set({ status: "cancelled", cancelledAt: new Date(), currentPeriodEnd: new Date(), updatedAt: new Date() })
          .where(eq(subscriptions.id, subscriptionId));
        await setUserPlanMirror(userId, "free");
      }
    }
  }

  const user = await loadUserForNotice(userId);
  const dashboardUrl = `${resolveAppUrl(params.request)}/account?tab=billing`;
  if (user.email) {
    const template = paymentFailedEmail({ displayName: user.displayName, planName, graceUntil, billingUrl: dashboardUrl });
    await sendEmail({ to: user.email, kind: "payment_failed", ...template });
  }
  await notifyUser({
    userId,
    kind: "payment_failed",
    title: "Payment could not be confirmed",
    body: graceUntil
      ? `We could not confirm your ${planName} payment. Premium continues until ${graceUntil.toUTCString()} while the charge is retried.`
      : `We could not confirm your ${planName} payment. Your account has returned to the Free plan; your files are safe.`,
    sendEmailCopy: false,
    request: params.request,
  });
  return { handled: true };
}

export async function applyRefund(params: {
  providerId: string;
  providerPaymentId: string | null;
  request?: Request;
}): Promise<{ handled: boolean }> {
  if (!params.providerPaymentId) return { handled: false };
  const [payment] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.provider, params.providerId), eq(payments.providerPaymentId, params.providerPaymentId)))
    .limit(1);
  if (!payment) return { handled: false };

  await db.update(payments).set({ status: "refunded", updatedAt: new Date() }).where(eq(payments.id, payment.id));
  if (payment.subscriptionId) {
    await db
      .update(subscriptions)
      .set({ status: "cancelled", cancelledAt: new Date(), currentPeriodEnd: new Date(), updatedAt: new Date() })
      .where(eq(subscriptions.id, payment.subscriptionId));
  }
  await setUserPlanMirror(payment.userId, "free");
  await notifyUser({
    userId: payment.userId,
    kind: "payment_refunded",
    title: "Refund processed",
    body: "Your payment was refunded and Premium has ended. Your files remain available on the Free plan.",
    sendEmailCopy: true,
    request: params.request,
  });
  return { handled: true };
}

/* ------------------------------------------------------------------ */
/* Webhook ingestion                                                   */
/* ------------------------------------------------------------------ */

type SafepayWebhookPayload = {
  token?: string;
  type?: string;
  created_at?: string;
  notification?: {
    tracker?: string;
    reference?: string;
    state?: string;
    amount?: string | number;
    currency?: string;
    user?: string;
    metadata?: Record<string, unknown>;
    subscription?: string | { id?: string };
    plan_id?: string;
    reason?: string;
    message?: string;
  };
  data?: Record<string, unknown>;
};

export type WebhookProcessResult = {
  received: boolean;
  duplicate: boolean;
  outcome: string;
  status: number;
};

export async function processProviderWebhook(params: {
  providerId: string;
  rawBody: string;
  signature: string | null;
  request?: Request;
}): Promise<WebhookProcessResult> {
  const provider = getPaymentProvider(params.providerId);
  if (!provider) return { received: false, duplicate: false, outcome: "unknown_provider", status: 404 };

  const signatureValid = provider.verifyWebhookSignature(params.rawBody, params.signature);

  let payload: SafepayWebhookPayload = {};
  try {
    payload = JSON.parse(params.rawBody) as SafepayWebhookPayload;
  } catch {
    payload = {};
  }

  const eventType = sanitizeText(payload.type, 80) || "unknown";
  const notification = payload.notification ?? {};
  const tracker = typeof notification.tracker === "string" ? notification.tracker : null;
  const eventId =
    sanitizeText(payload.token, 200) ||
    createHash("sha256").update(params.rawBody).digest("hex");

  // Record first: the unique index on (provider, event_id) is the idempotency key.
  const inserted = await db
    .insert(paymentWebhookEvents)
    .values({
      provider: params.providerId,
      eventId,
      eventType,
      signatureValid,
      payload: (payload as unknown as Record<string, unknown>) ?? {},
      status: signatureValid ? "received" : "error",
      error: signatureValid ? null : "invalid_signature",
    })
    .onConflictDoNothing({ target: [paymentWebhookEvents.provider, paymentWebhookEvents.eventId] })
    .returning({ id: paymentWebhookEvents.id });

  if (!inserted.length) {
    return { received: true, duplicate: true, outcome: "duplicate", status: 200 };
  }
  const eventRowId = inserted[0]!.id;

  if (!signatureValid) {
    // Never process an unsigned or badly signed event.
    return { received: false, duplicate: false, outcome: "invalid_signature", status: 401 };
  }

  const state = (notification.state ?? "").toUpperCase();
  const type = eventType.toLowerCase();
  const metadata = (notification.metadata ?? {}) as Record<string, unknown>;
  const subscriptionIdHint =
    (typeof metadata.reference === "string" && metadata.reference) ||
    (typeof notification.reference === "string" && /^[0-9a-f-]{36}$/i.test(notification.reference) ? notification.reference : null) ||
    null;
  const providerSubscriptionId =
    typeof notification.subscription === "string"
      ? notification.subscription
      : typeof notification.subscription === "object" && notification.subscription
        ? (notification.subscription.id ?? null)
        : null;
  const amountMinor =
    typeof notification.amount === "number"
      ? Math.round(notification.amount * 100)
      : typeof notification.amount === "string" && /^\d+(\.\d+)?$/.test(notification.amount)
        ? Math.round(Number(notification.amount) * 100)
        : null;

  let outcome = "ignored";
  try {
    const isFailure =
      type.includes("fail") || ["FAILED", "DECLINED", "CANCELLED", "CANCELED", "VOIDED", "EXPIRED"].includes(state);
    const isRefund = type.includes("refund") || ["REFUNDED", "PARTIALLY_REFUNDED"].includes(state);
    const isSuccess =
      type.includes("succeed") ||
      type.includes("paid") ||
      type.includes("captured") ||
      ["PAID", "CAPTURED", "SUCCEEDED", "COMPLETED", "SETTLED"].includes(state);

    if (isRefund) {
      const result = await applyRefund({ providerId: params.providerId, providerPaymentId: tracker, request: params.request });
      outcome = result.handled ? "refunded" : "refund_unmatched";
    } else if (isFailure) {
      const result = await applyPaymentFailure({
        providerId: params.providerId,
        providerPaymentId: tracker,
        reason: notification.reason ?? notification.message ?? state ?? eventType,
        subscriptionIdHint,
        request: params.request,
      });
      outcome = result.handled ? "payment_failed" : "failure_unmatched";
    } else if (isSuccess) {
      const activation = await activatePaidPayment({
        providerId: params.providerId,
        providerPaymentId: tracker,
        providerReference: notification.reference ?? null,
        amountMinor,
        currency: notification.currency ?? null,
        metadata,
        subscriptionIdHint,
        providerSubscriptionId,
        source: "webhook",
      });
      outcome = activation.status;
      if (activation.status === "activated" || activation.status === "extended") {
        await announceActivation(activation, params.request);
      }
    } else if (type.startsWith("subscription")) {
      outcome = await handleSubscriptionEvent({
        providerId: params.providerId,
        eventType,
        state,
        providerSubscriptionId,
        subscriptionIdHint,
        metadata,
        notification,
      });
    }

    await db
      .update(paymentWebhookEvents)
      .set({ status: outcome === "ignored" ? "ignored" : "processed", processedAt: new Date() })
      .where(eq(paymentWebhookEvents.id, eventRowId));
    return { received: true, duplicate: false, outcome, status: 200 };
  } catch (error) {
    console.error("[billing] webhook processing failed", error);
    await db
      .update(paymentWebhookEvents)
      .set({ status: "error", error: error instanceof Error ? error.message.slice(0, 500) : "unknown", processedAt: new Date() })
      .where(eq(paymentWebhookEvents.id, eventRowId));
    return { received: true, duplicate: false, outcome: "processing_error", status: 500 };
  }
}

async function handleSubscriptionEvent(params: {
  providerId: string;
  eventType: string;
  state: string;
  providerSubscriptionId: string | null;
  subscriptionIdHint: string | null;
  metadata: Record<string, unknown>;
  notification: SafepayWebhookPayload["notification"];
}): Promise<string> {
  const type = params.eventType.toLowerCase();
  let subscription: SubscriptionRow | null = null;

  if (params.subscriptionIdHint) {
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, params.subscriptionIdHint)).limit(1);
    subscription = row ?? null;
  }
  if (!subscription && params.providerSubscriptionId) {
    const [row] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.provider, params.providerId),
          eq(subscriptions.providerSubscriptionId, params.providerSubscriptionId),
        ),
      )
      .limit(1);
    subscription = row ?? null;
  }
  if (!subscription) return "subscription_unmatched";

  if (type.includes("cancel")) {
    await db
      .update(subscriptions)
      .set({ status: "cancelled", cancelledAt: new Date(), cancelAtPeriodEnd: true, updatedAt: new Date() })
      .where(eq(subscriptions.id, subscription.id));
    return "subscription_cancelled";
  }
  if (type.includes("pause")) {
    await db
      .update(subscriptions)
      .set({ status: "past_due", updatedAt: new Date() })
      .where(eq(subscriptions.id, subscription.id));
    return "subscription_paused";
  }
  if (type.includes("expire") || type.includes("end")) {
    await db
      .update(subscriptions)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(subscriptions.id, subscription.id));
    await setUserPlanMirror(subscription.userId, "free");
    return "subscription_expired";
  }
  return "subscription_event_recorded";
}

/* ------------------------------------------------------------------ */
/* Return verification and user-initiated cancellation                 */
/* ------------------------------------------------------------------ */

/**
 * Called by /billing/return. The browser's word is not trusted: the `sig` is
 * validated with the merchant secret, then the payment state is fetched from
 * Safepay server-to-server before anything is activated.
 */
export async function verifyCheckoutReturn(params: {
  paymentId: string;
  userId: string;
  tracker: string | null;
  signature: string | null;
  request: Request;
}): Promise<{ status: "paid" | "pending" | "failed" | "unknown"; message: string }> {
  // Ownership is part of the lookup: a payment id belonging to someone else is
  // indistinguishable from a payment that does not exist.
  const [payment] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, params.paymentId), eq(payments.userId, params.userId)))
    .limit(1);
  if (!payment) return { status: "unknown", message: "We could not find that payment." };
  if (payment.status === "succeeded") return { status: "paid", message: "Payment confirmed. Premium is active." };

  const provider = getPaymentProvider(payment.provider);
  if (!provider) return { status: "unknown", message: "This payment provider is not available." };

  const tracker = params.tracker ?? payment.providerPaymentId;
  if (!tracker) return { status: "pending", message: "Waiting for the payment confirmation." };

  if (params.signature && provider.verifyReturnSignature) {
    const valid = provider.verifyReturnSignature(tracker, params.signature);
    if (!valid) {
      console.warn("[billing] return signature did not validate", { paymentId: params.paymentId });
      return { status: "failed", message: "The payment confirmation could not be verified. Contact support if you were charged." };
    }
  }

  // A provider outage must not surface as a 500 on the return page and must
  // never be treated as success: we simply keep waiting for the webhook.
  let state: Awaited<ReturnType<typeof provider.fetchPayment>>;
  try {
    state = await provider.fetchPayment(tracker);
  } catch (error) {
    console.warn("[billing] could not reach the payment provider while verifying a return", {
      paymentId: params.paymentId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "pending",
      message: "We could not reach the payment provider just now. No Premium was activated — this page keeps checking.",
    };
  }
  if (state.state === "paid") {
    const outcome = await activatePaidPayment({
      providerId: payment.provider,
      providerPaymentId: tracker,
      providerReference: state.reference,
      amountMinor: state.amountMinor,
      currency: state.currency,
      metadata: { source: "return_verification" },
      subscriptionIdHint: payment.subscriptionId,
      providerSubscriptionId: null,
      source: "return_verification",
    });
    if (outcome.status === "activated" || outcome.status === "extended" || outcome.status === "duplicate") {
      await announceActivation(outcome, params.request);
      return { status: "paid", message: "Payment confirmed. Premium is active." };
    }
    return { status: "pending", message: "The payment is being confirmed. This page updates automatically." };
  }
  if (state.state === "failed") {
    await applyPaymentFailure({
      providerId: payment.provider,
      providerPaymentId: tracker,
      reason: state.reason,
      subscriptionIdHint: payment.subscriptionId,
      request: params.request,
    });
    return { status: "failed", message: "The payment was not completed. No Premium was activated." };
  }
  if (state.state === "refunded") {
    await applyRefund({ providerId: payment.provider, providerPaymentId: tracker, request: params.request });
    return { status: "failed", message: "This payment was refunded." };
  }
  return { status: "pending", message: "Waiting for Safepay to confirm the payment. This page updates automatically." };
}

export async function cancelUserSubscription(params: {
  userId: string;
  immediate?: boolean;
  request?: Request;
}): Promise<{ status: "cancelled_at_period_end" | "cancelled_now"; providerNotified: boolean }> {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, params.userId),
        inArray(subscriptions.status, ["active", "past_due"]),
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  if (!sub) throw new HttpError(404, "There is no active subscription to cancel.", "no_subscription");

  let providerNotified = false;
  if (sub.billingMode === "recurring" && sub.providerSubscriptionId) {
    const provider = getPaymentProvider(sub.provider);
    if (provider) {
      providerNotified = await provider.cancelSubscription(sub.providerSubscriptionId).catch(() => false);
      if (!providerNotified) {
        throw new HttpError(
          502,
          "We could not reach the payment provider to cancel the recurring charge. Nothing was changed — please try again or contact support.",
          "provider_cancel_failed",
        );
      }
    }
  }

  if (params.immediate) {
    await db
      .update(subscriptions)
      .set({ status: "cancelled", cancelledAt: new Date(), currentPeriodEnd: new Date(), cancelAtPeriodEnd: true, updatedAt: new Date() })
      .where(eq(subscriptions.id, sub.id));
    await setUserPlanMirror(sub.userId, "free");
  } else {
    await db
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: true, cancelledAt: new Date(), updatedAt: new Date() })
      .where(eq(subscriptions.id, sub.id));
  }

  await notifyUser({
    userId: params.userId,
    kind: "subscription_cancelled",
    title: "Subscription cancelled",
    body: params.immediate
      ? "Your Premium subscription ended. Your files are safe on the Free plan."
      : `Your subscription will not renew. Premium stays active until ${sub.currentPeriodEnd?.toUTCString() ?? "the end of the paid term"}, then your account returns to the Free plan. Your files are never deleted.`,
    request: params.request,
  });

  return { status: params.immediate ? "cancelled_now" : "cancelled_at_period_end", providerNotified };
}

/* ------------------------------------------------------------------ */
/* Lifecycle maintenance                                               */
/* ------------------------------------------------------------------ */

export type LifecycleResult = { expired: number; pastDueExpired: number; pendingCancelled: number };

/**
 * Downgrades subscriptions whose paid term has ended. Files are preserved:
 * the quota simply drops back to the Free allowance and further uploads are blocked while the
 * account is over it.
 */
export async function syncSubscriptionLifecycle(): Promise<LifecycleResult> {
  const expired = await db.execute<{ user_id: string; id: string }>(sql`
    update subscriptions
    set status = 'expired', updated_at = now()
    where status = 'active'
      and current_period_end is not null
      and current_period_end <= now()
    returning user_id, id
  `);

  const pastDueExpired = await db.execute<{ user_id: string; id: string }>(sql`
    update subscriptions
    set status = 'expired', updated_at = now()
    where status = 'past_due'
      and grace_until is not null
      and grace_until <= now()
    returning user_id, id
  `);

  const pendingCancelled = await db.execute<{ user_id: string; id: string }>(sql`
    update subscriptions
    set status = 'cancelled', cancelled_at = coalesce(cancelled_at, now()), updated_at = now()
    where status = 'pending'
      and created_at <= now() - interval '24 hours'
    returning user_id, id
  `);

  // Keep the denormalised plan mirror in step with reality.
  await db.execute(sql`
    update users
    set plan = 'premium', updated_at = now()
    where id in (
      select user_id from subscriptions
      where status = 'active' and (current_period_end is null or current_period_end > now())
    ) and plan <> 'premium'
  `);
  await db.execute(sql`
    update users
    set plan = 'free', updated_at = now()
    where plan = 'premium'
      and id not in (
        select user_id from subscriptions
        where status = 'active' and (current_period_end is null or current_period_end > now())
        union
        select user_id from subscriptions
        where status = 'past_due' and grace_until > now()
        union
        select user_id from subscriptions
        where status = 'cancelled' and current_period_end > now()
      )
  `);

  for (const row of [...expired.rows, ...pastDueExpired.rows]) {
    const user = await loadUserForNotice(row.user_id);
    await notifyUser({
      userId: row.user_id,
      kind: "subscription_expired",
      title: "Premium has ended",
      body: `Your account is back on the Free plan with ${planStorageLabel(config.plans.freeStorageBytes)} of storage. Your files were not deleted — delete some files or upgrade again to upload more.`,
      email: user.email,
      displayName: user.displayName,
      sendEmailCopy: true,
    });
  }

  return {
    expired: expired.rows.length,
    pastDueExpired: pastDueExpired.rows.length,
    pendingCancelled: pendingCancelled.rows.length,
  };
}

export async function listUserPayments(userId: string, limit = 25) {
  const rows = await db
    .select({ payment: payments, plan: subscriptionPlans })
    .from(payments)
    .leftJoin(subscriptionPlans, eq(subscriptionPlans.id, payments.planId))
    .where(eq(payments.userId, userId))
    .orderBy(desc(payments.createdAt))
    .limit(Math.min(100, Math.max(1, limit)));
  return rows.map(({ payment, plan }) => ({
    id: payment.id,
    planName: plan?.name ?? payment.planId ?? "Premium",
    interval: plan?.interval ?? null,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    status: payment.status as "pending" | "succeeded" | "failed" | "refunded" | "cancelled",
    provider: payment.provider,
    reference: payment.providerReference,
    failureReason: payment.failureReason,
    createdAt: payment.createdAt.toISOString(),
    paidAt: payment.paidAt?.toISOString() ?? null,
  }));
}

export async function listUserNotifications(userId: string, limit = 10) {
  const rows = await db.execute<{ id: string; title: string; body: string; kind: string; created_at: string; read_at: string | null }>(sql`
    select id, title, body, kind, created_at, read_at
    from user_notifications
    where user_id = ${userId}
    order by created_at desc
    limit ${Math.min(50, Math.max(1, limit))}
  `);
  return rows.rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    kind: row.kind,
    createdAt: new Date(row.created_at).toISOString(),
    read: Boolean(row.read_at),
  }));
}

export { config as billingConfig };
