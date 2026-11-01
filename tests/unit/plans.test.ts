import { describe, expect, it } from "vitest";
import {
  DEFAULT_FREE_STORAGE_BYTES,
  DEFAULT_PREMIUM_STORAGE_BYTES,
  FREE_STORAGE_BYTES,
  PREMIUM_STORAGE_BYTES,
  buildStorageSnapshot,
  formatBytes,
  formatMoneyMinor,
  planStorageLabel,
} from "@/lib/plans";

describe("plan quotas", () => {
  it("sizes the default quotas for the free storage tier (200 MB / 2 GB)", () => {
    // Cloudflare R2 gives 10 GB of object storage for free, so the smallest
    // sensible quotas are used by default and can be raised in the admin UI.
    expect(DEFAULT_FREE_STORAGE_BYTES).toBe(200 * 1024 * 1024);
    expect(DEFAULT_PREMIUM_STORAGE_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(FREE_STORAGE_BYTES).toBe(DEFAULT_FREE_STORAGE_BYTES);
    expect(PREMIUM_STORAGE_BYTES).toBe(DEFAULT_PREMIUM_STORAGE_BYTES);
    expect(PREMIUM_STORAGE_BYTES).toBeGreaterThan(FREE_STORAGE_BYTES);
  });

  it("reports remaining capacity and percentage", () => {
    const snapshot = buildStorageSnapshot({ usedBytes: 50 * 1024 * 1024, quotaBytes: FREE_STORAGE_BYTES, fileCount: 3 });
    expect(snapshot.remainingBytes).toBe(150 * 1024 * 1024);
    expect(snapshot.percentUsed).toBe(25);
    expect(snapshot.overQuota).toBe(false);
    expect(snapshot.uploadsBlocked).toBe(false);
    expect(snapshot.fileCount).toBe(3);
  });

  it("blocks uploads at or above the quota but keeps files", () => {
    const atLimit = buildStorageSnapshot({ usedBytes: FREE_STORAGE_BYTES, quotaBytes: FREE_STORAGE_BYTES });
    expect(atLimit.overQuota).toBe(true);
    expect(atLimit.uploadsBlocked).toBe(true);
    expect(atLimit.uploadsBlockedReason).toMatch(/at or above your plan limit/i);

    const overAfterDowngrade = buildStorageSnapshot({ usedBytes: 6 * 1024 * 1024 * 1024, quotaBytes: FREE_STORAGE_BYTES });
    expect(overAfterDowngrade.overQuota).toBe(true);
    expect(overAfterDowngrade.remainingBytes).toBe(0);
    expect(overAfterDowngrade.percentUsed).toBe(100);
  });

  it("never reports negative usage", () => {
    const snapshot = buildStorageSnapshot({ usedBytes: -50, quotaBytes: PREMIUM_STORAGE_BYTES });
    expect(snapshot.usedBytes).toBe(0);
    expect(snapshot.remainingBytes).toBe(PREMIUM_STORAGE_BYTES);
  });
});

describe("formatting", () => {
  it("formats byte counts", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2_000_000_000)).toBe("1.9 GB");
    expect(formatBytes(10_000_000_000)).toBe("9.3 GB");
    expect(planStorageLabel(DEFAULT_FREE_STORAGE_BYTES)).toBe("200 MB");
    expect(planStorageLabel(DEFAULT_PREMIUM_STORAGE_BYTES)).toBe("2 GB");
  });

  it("formats money from minor units", () => {
    expect(formatMoneyMinor(150000, "PKR")).toContain("1,500");
    expect(formatMoneyMinor(1500000, "PKR")).toContain("15,000");
    expect(formatMoneyMinor(0, "USD")).toContain("0");
  });
});
