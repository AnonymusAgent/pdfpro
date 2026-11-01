/**
 * Plan constants shared by the server and the browser.
 * The server remains authoritative: quotas are re-read from the database and
 * the active subscription on every upload.
 */

/**
 * Default plan quotas, sized for the free tiers this deployment runs on
 * (Cloudflare R2: 10 GB of object storage, Neon: 1 GB of Postgres per project).
 *
 *   Free    200 MB   – roughly 50 accounts fill the R2 free tier
 *   Premium   2 GB   – roughly 5 paying accounts fill it
 *
 * Both are overridable without a code change:
 *   FREE_PLAN_STORAGE_BYTES / PREMIUM_PLAN_STORAGE_BYTES (server config)
 *   subscription_plans.storage_bytes                     (admin → pricing)
 *
 * Raise them from the admin dashboard once the storage plan is upgraded.
 */
export const DEFAULT_FREE_STORAGE_BYTES = 200 * 1024 * 1024; // 200 MiB
export const DEFAULT_PREMIUM_STORAGE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/** Browser-side fallbacks; the server always uses the configured values. */
export const FREE_STORAGE_BYTES = DEFAULT_FREE_STORAGE_BYTES;
export const PREMIUM_STORAGE_BYTES = DEFAULT_PREMIUM_STORAGE_BYTES;

export type PlanId = "free" | "premium";
export type BillingInterval = "month" | "year";

export const PLAN_LABELS: Record<PlanId, string> = {
  free: "Free",
  premium: "Premium",
};

export type StorageSnapshot = {
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
  percentUsed: number;
  fileCount: number;
  overQuota: boolean;
  uploadsBlocked: boolean;
  uploadsBlockedReason: string | null;
};

export function buildStorageSnapshot(input: {
  usedBytes: number;
  quotaBytes: number;
  fileCount?: number;
  maxUploadBytes?: number;
}): StorageSnapshot {
  const usedBytes = Math.max(0, Math.floor(input.usedBytes));
  const quotaBytes = Math.max(1, Math.floor(input.quotaBytes));
  const remainingBytes = Math.max(0, quotaBytes - usedBytes);
  const overQuota = usedBytes >= quotaBytes;
  const maxUploadBytes = input.maxUploadBytes ?? remainingBytes;
  let uploadsBlockedReason: string | null = null;
  if (overQuota) {
    uploadsBlockedReason =
      "Your storage is at or above your plan limit. Delete files to free space, or upgrade to Premium.";
  } else if (remainingBytes < Math.min(maxUploadBytes, 1024)) {
    uploadsBlockedReason = "Only a few bytes of storage remain on your plan.";
  }
  return {
    usedBytes,
    quotaBytes,
    remainingBytes,
    percentUsed: Math.min(100, Math.round((usedBytes / quotaBytes) * 1000) / 10),
    fileCount: input.fileCount ?? 0,
    overQuota,
    uploadsBlocked: Boolean(uploadsBlockedReason),
    uploadsBlockedReason,
  };
}

/** Format bytes for the UI (binary units, like the rest of the app). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  // One decimal for small magnitudes, whole numbers above 10 — and no trailing
  // ".0", so a 2 GiB quota reads "2 GB" rather than "2.0 GB".
  const label = value >= 10 || exponent === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${label} ${units[exponent]}`;
}

/** "200 MB", "2 GB" — the label used for plan quotas in the UI and emails. */
export function planStorageLabel(bytes: number): string {
  return formatBytes(bytes);
}

/** Kept for older copy; prefer planStorageLabel for plan quotas. */
export function gigabytes(bytes: number): string {
  return `${Math.round((bytes / 1_000_000_000) * 10) / 10} GB`;
}

/**
 * Format a minor-unit amount (e.g. 1500 = PKR 15.00) using the plan currency.
 * Safepay's PKR amounts are expressed in paisa.
 */
export function formatMoneyMinor(amountMinor: number, currency: string): string {
  const amount = amountMinor / 100;
  try {
    return new Intl.NumberFormat("en-PK", {
      style: "currency",
      currency: currency.toUpperCase(),
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency.toUpperCase()} ${amount.toFixed(2)}`;
  }
}

export type PlanSummary = {
  id: string;
  name: string;
  description: string | null;
  interval: BillingInterval;
  priceMinor: number;
  currency: string;
  compareAtMinor: number | null;
  billingMode: "one_time" | "recurring";
  storageBytes: number;
  features: string[];
  active: boolean;
  sortOrder: number;
};
