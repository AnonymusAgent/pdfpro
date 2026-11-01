import { describe, expect, it } from "vitest";
import {
  FREE_STORAGE_BYTES,
  PREMIUM_STORAGE_BYTES,
  buildStorageSnapshot,
  formatBytes,
  formatMoneyMinor,
} from "@/lib/plans";

describe("plan quotas", () => {
  it("defines the documented 2 GB / 10 GB limits", () => {
    expect(FREE_STORAGE_BYTES).toBe(2_000_000_000);
    expect(PREMIUM_STORAGE_BYTES).toBe(10_000_000_000);
  });

  it("reports remaining capacity and percentage", () => {
    const snapshot = buildStorageSnapshot({ usedBytes: 500_000_000, quotaBytes: FREE_STORAGE_BYTES, fileCount: 3 });
    expect(snapshot.remainingBytes).toBe(1_500_000_000);
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

    const overAfterDowngrade = buildStorageSnapshot({ usedBytes: 6_000_000_000, quotaBytes: FREE_STORAGE_BYTES });
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
  });

  it("formats money from minor units", () => {
    expect(formatMoneyMinor(150000, "PKR")).toContain("1,500");
    expect(formatMoneyMinor(1500000, "PKR")).toContain("15,000");
    expect(formatMoneyMinor(0, "USD")).toContain("0");
  });
});
