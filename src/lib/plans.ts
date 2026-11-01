/**
 * Plan constants shared by the server and the browser.
 * The server remains authoritative: quotas are re-read from the database and
 * the active subscription on every upload.
 */

export const FREE_STORAGE_BYTES = 2_000_000_000; // 2 GB
export const PREMIUM_STORAGE_BYTES = 10_000_000_000; // 10 GB

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
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

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
