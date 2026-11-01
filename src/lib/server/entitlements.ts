/**
 * Authoritative plan entitlement.
 *
 * Never trust `users.plan` from the browser (or from an out-of-date denormalised
 * value): Premium is derived from a verified, in-term subscription record on
 * every request. `users.plan` is only a mirror used by admin reporting.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { storageUsage, subscriptionPlans, subscriptions } from "@/db/schema";
import { buildStorageSnapshot, FREE_STORAGE_BYTES, PREMIUM_STORAGE_BYTES, type StorageSnapshot } from "@/lib/plans";
import { getStorageSettings } from "./platform-settings";

export type SubscriptionSummary = {
  id: string;
  planId: string;
  planName: string;
  interval: "month" | "year";
  billingMode: "one_time" | "recurring";
  status: "pending" | "active" | "past_due" | "cancelled" | "expired";
  provider: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  graceUntil: string | null;
  cancelledAt: string | null;
};

export type Entitlements = {
  plan: "free" | "premium";
  quotaBytes: number;
  usedBytes: number;
  fileCount: number;
  maxUploadBytes: number;
  storage: StorageSnapshot;
  subscription: (SubscriptionSummary & { planStorageBytes: number }) | null;
  /** When access to Premium benefits stops (null when free or open-ended). */
  premiumEndsAt: string | null;
  inGracePeriod: boolean;
};

type SubscriptionRow = typeof subscriptions.$inferSelect;
type PlanRow = typeof subscriptionPlans.$inferSelect;

/** Premium access rules for each lifecycle state. */
export function subscriptionGrantsAccess(sub: SubscriptionRow, now = new Date()): boolean {
  switch (sub.status) {
    case "active":
      return !sub.currentPeriodEnd || sub.currentPeriodEnd.getTime() > now.getTime();
    case "past_due":
      // Grace period keeps the user Premium while the provider retries.
      return Boolean(sub.graceUntil && sub.graceUntil.getTime() > now.getTime());
    case "cancelled":
      // Cancelled at period end: access survives until the paid term ends.
      return Boolean(sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() > now.getTime());
    default:
      return false;
  }
}

function accessEndsAt(sub: SubscriptionRow): Date | null {
  if (sub.status === "past_due" && sub.graceUntil) return sub.graceUntil;
  if (sub.status === "cancelled") return sub.currentPeriodEnd;
  return sub.currentPeriodEnd;
}

function summarize(sub: SubscriptionRow, plan: PlanRow | undefined): SubscriptionSummary & { planStorageBytes: number } {
  return {
    id: sub.id,
    planId: sub.planId,
    planName: plan?.name ?? sub.planId,
    interval: (plan?.interval === "year" ? "year" : "month") as "month" | "year",
    billingMode: (sub.billingMode === "recurring" ? "recurring" : "one_time") as "one_time" | "recurring",
    status: sub.status as SubscriptionSummary["status"],
    provider: sub.provider,
    currentPeriodStart: sub.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    graceUntil: sub.graceUntil?.toISOString() ?? null,
    cancelledAt: sub.cancelledAt?.toISOString() ?? null,
    planStorageBytes: plan?.storageBytes ?? PREMIUM_STORAGE_BYTES,
  };
}

/**
 * Any Drizzle query surface: the pooled `db` or a transaction handle. Passing
 * the transaction keeps the caller inside a single pooled connection, which
 * matters because `uploadPdfFile` must not wait for a second connection while
 * holding a row lock.
 */
export type DbExecutor = Pick<typeof db, "select" | "execute">;

export async function getEntitlements(
  userId: string,
  executor: DbExecutor = db,
  maxUploadBytesOverride?: number,
): Promise<Entitlements> {
  const now = new Date();

  const [usage] = await executor
    .select({ usedBytes: storageUsage.usedBytes, fileCount: storageUsage.fileCount })
    .from(storageUsage)
    .where(eq(storageUsage.userId, userId))
    .limit(1);

  const rows = await executor
    .select({ sub: subscriptions, plan: subscriptionPlans })
    .from(subscriptions)
    .leftJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.planId))
    .where(
      and(
        eq(subscriptions.userId, userId),
        inArray(subscriptions.status, ["active", "past_due", "cancelled", "pending", "expired"]),
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(10);

  const granting = rows.filter((row) => subscriptionGrantsAccess(row.sub, now));
  // Prefer the access-granting row with the furthest end date, then fall back to
  // the most recent row so the dashboard can still show "pending"/"expired".
  granting.sort((a, b) => {
    const aEnd = accessEndsAt(a.sub)?.getTime() ?? 0;
    const bEnd = accessEndsAt(b.sub)?.getTime() ?? 0;
    return bEnd - aEnd;
  });
  const chosen = granting[0] ?? rows[0] ?? null;

  const maxUploadBytes = maxUploadBytesOverride ?? (await getStorageSettings()).maxUploadBytes;
  const usedBytes = Number(usage?.usedBytes ?? 0);
  const fileCount = Number(usage?.fileCount ?? 0);

  if (granting[0]) {
    const summary = summarize(granting[0].sub, granting[0].plan ?? undefined);
    const quotaBytes = summary.planStorageBytes || PREMIUM_STORAGE_BYTES;
    return {
      plan: "premium",
      quotaBytes,
      usedBytes,
      fileCount,
      maxUploadBytes,
      storage: buildStorageSnapshot({
        usedBytes,
        quotaBytes,
        fileCount,
        maxUploadBytes,
      }),
      subscription: summary,
      premiumEndsAt: accessEndsAt(granting[0].sub)?.toISOString() ?? null,
      inGracePeriod: granting[0].sub.status === "past_due",
    };
  }

  return {
    plan: "free",
    quotaBytes: FREE_STORAGE_BYTES,
    usedBytes,
    fileCount,
    maxUploadBytes,
    storage: buildStorageSnapshot({
      usedBytes,
      quotaBytes: FREE_STORAGE_BYTES,
      fileCount,
      maxUploadBytes,
    }),
    subscription: chosen ? summarize(chosen.sub, chosen.plan ?? undefined) : null,
    premiumEndsAt: null,
    inGracePeriod: false,
  };
}

/** Cheap check used by the ad layer. */
export async function isPremiumUser(userId: string): Promise<boolean> {
  const entitlements = await getEntitlements(userId);
  return entitlements.plan === "premium";
}
