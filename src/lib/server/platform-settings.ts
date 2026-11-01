/**
 * Administrator-editable platform settings.
 *
 * Stored in the existing `settings` key/value table so deployments keep their
 * data. Values are validated on write and merged over defaults on read, so a
 * partially-filled row can never break the application.
 */
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { config } from "./config";

export type BillingSettings = {
  graceDays: number;
  paused: boolean;
  supportEmail: string;
  prorationNote: string;
};

export type AdsenseSettings = {
  enabled: boolean;
  publisherId: string;
  slots: Record<string, string>;
  requireConsent: boolean;
};

export type StorageSettings = {
  maxUploadBytes: number;
};

export const DEFAULT_BILLING: BillingSettings = {
  graceDays: config.billing.graceDays,
  paused: config.billing.disabled,
  supportEmail: "billing@example.com",
  prorationNote: "",
};

export const DEFAULT_ADSENSE: AdsenseSettings = {
  enabled: config.adsense.enabled,
  publisherId: config.adsense.publisherId,
  slots: Object.fromEntries(
    Object.entries(config.adsense.slots).filter(([, value]) => Boolean(value)),
  ) as Record<string, string>,
  requireConsent: true,
};

export const DEFAULT_STORAGE: StorageSettings = {
  maxUploadBytes: config.storage.maxUploadBytes,
};

const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { value: unknown; at: number }>();

async function readSetting(key: string): Promise<unknown> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
  const value = row?.value ?? null;
  cache.set(key, { value, at: Date.now() });
  return value;
}

export function invalidateSettingsCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

export async function getBillingSettings(): Promise<BillingSettings> {
  const raw = (await readSetting("billing")) as Partial<BillingSettings> | null;
  return {
    ...DEFAULT_BILLING,
    ...(raw ?? {}),
    graceDays: clampNumber(raw?.graceDays, 0, 60, DEFAULT_BILLING.graceDays),
    paused: typeof raw?.paused === "boolean" ? raw.paused : DEFAULT_BILLING.paused,
    supportEmail: typeof raw?.supportEmail === "string" ? raw.supportEmail.slice(0, 200) : DEFAULT_BILLING.supportEmail,
    prorationNote: typeof raw?.prorationNote === "string" ? raw.prorationNote.slice(0, 500) : "",
  };
}

export async function getAdsenseSettings(): Promise<AdsenseSettings> {
  const raw = (await readSetting("adsense")) as Partial<AdsenseSettings> | null;
  const slots: Record<string, string> = {};
  if (raw?.slots && typeof raw.slots === "object") {
    for (const [placement, slot] of Object.entries(raw.slots)) {
      if (typeof slot === "string" && /^\d{3,30}$/.test(slot)) slots[placement] = slot;
    }
  }
  const publisherId =
    typeof raw?.publisherId === "string" && /^ca-pub-\d{10,20}$/.test(raw.publisherId)
      ? raw.publisherId
      : DEFAULT_ADSENSE.publisherId;
  return {
    enabled: (typeof raw?.enabled === "boolean" ? raw.enabled : DEFAULT_ADSENSE.enabled) && Boolean(publisherId),
    publisherId,
    slots,
    requireConsent: typeof raw?.requireConsent === "boolean" ? raw.requireConsent : true,
  };
}

export async function getStorageSettings(): Promise<StorageSettings> {
  const raw = (await readSetting("storage")) as Partial<StorageSettings> | null;
  return { maxUploadBytes: clampNumber(raw?.maxUploadBytes, 1024, 500 * 1024 * 1024, DEFAULT_STORAGE.maxUploadBytes) };
}

/** Only administrator-scoped code calls this. */
export async function saveSetting(key: "billing" | "adsense" | "storage", value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value: value as never })
    .onConflictDoUpdate({ target: settings.key, set: { value: value as never, updatedAt: new Date() } });
  invalidateSettingsCache(key);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
