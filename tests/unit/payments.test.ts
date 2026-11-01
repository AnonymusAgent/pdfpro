import { describe, expect, it } from "vitest";
import { hmacHex } from "@/lib/server/crypto";
import { SafepayProvider } from "@/lib/server/payments/safepay";
import { addInterval } from "@/lib/server/payments/billing";
import { subscriptionGrantsAccess } from "@/lib/server/entitlements";
import { createSignedFileToken, verifySignedFileToken } from "@/lib/server/files";
import { randomUUID } from "node:crypto";

const webhookSecret = process.env.SAFEPAY_WEBHOOK_SECRET!;
const v1Secret = process.env.SAFEPAY_V1_SECRET!;

describe("Safepay signature verification", () => {
  const provider = new SafepayProvider();
  const body = JSON.stringify({
    token: "evt_123",
    type: "payment.succeeded",
    notification: { tracker: "track_abc", state: "PAID", amount: "1500.00", currency: "PKR" },
  });

  it("accepts a correct HMAC-SHA512 webhook signature", () => {
    const signature = hmacHex(webhookSecret, body, "sha512");
    expect(provider.verifyWebhookSignature(body, signature)).toBe(true);
    expect(provider.verifyWebhookSignature(body, signature.toUpperCase())).toBe(true);
  });

  it("rejects tampered bodies, wrong secrets and missing signatures", () => {
    const signature = hmacHex(webhookSecret, body, "sha512");
    expect(provider.verifyWebhookSignature(`${body} `, signature)).toBe(false);
    expect(provider.verifyWebhookSignature(body, hmacHex("other-secret", body, "sha512"))).toBe(false);
    expect(provider.verifyWebhookSignature(body, null)).toBe(false);
    expect(provider.verifyWebhookSignature(body, "")).toBe(false);
  });

  it("verifies the checkout redirect signature (HMAC-SHA256 over the tracker)", () => {
    const tracker = "track_abc";
    const signature = hmacHex(v1Secret, tracker, "sha256");
    expect(provider.verifyReturnSignature(tracker, signature)).toBe(true);
    expect(provider.verifyReturnSignature("track_other", signature)).toBe(false);
    expect(provider.verifyReturnSignature(tracker, null)).toBe(false);
  });

  it("reports configuration state honestly", () => {
    expect(provider.isConfigured()).toBe(true);
    expect(provider.unavailableReason()).toBeNull();
  });
});

describe("subscription periods", () => {
  it("adds a calendar month or year", () => {
    expect(addInterval(new Date("2026-01-31T00:00:00Z"), "month").toISOString()).toBe("2026-03-03T00:00:00.000Z");
    expect(addInterval(new Date("2026-02-15T00:00:00Z"), "year").toISOString()).toBe("2027-02-15T00:00:00.000Z");
  });

  it("grants access only for verified, in-term states", () => {
    const base = {
      id: randomUUID(),
      userId: randomUUID(),
      planId: "premium_monthly",
      provider: "safepay",
      providerSubscriptionId: null,
      providerReference: null,
      billingMode: "one_time",
      currentPeriodStart: new Date("2026-01-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-02-01T00:00:00Z"),
      cancelAtPeriodEnd: false,
      graceUntil: null,
      cancelledAt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    };
    const now = new Date("2026-01-15T00:00:00Z");
    expect(subscriptionGrantsAccess({ ...base, status: "active" }, now)).toBe(true);
    expect(subscriptionGrantsAccess({ ...base, status: "active" }, new Date("2026-02-02T00:00:00Z"))).toBe(false);
    expect(subscriptionGrantsAccess({ ...base, status: "pending" }, now)).toBe(false);
    expect(subscriptionGrantsAccess({ ...base, status: "expired" }, now)).toBe(false);
    // Grace period keeps Premium while a failed renewal is retried.
    expect(
      subscriptionGrantsAccess(
        { ...base, status: "past_due", graceUntil: new Date("2026-01-18T00:00:00Z") },
        now,
      ),
    ).toBe(true);
    expect(
      subscriptionGrantsAccess(
        { ...base, status: "past_due", graceUntil: new Date("2026-01-10T00:00:00Z") },
        now,
      ),
    ).toBe(false);
    // Cancelled subscriptions keep access until the paid term ends.
    expect(subscriptionGrantsAccess({ ...base, status: "cancelled" }, now)).toBe(true);
    expect(subscriptionGrantsAccess({ ...base, status: "cancelled" }, new Date("2026-03-01T00:00:00Z"))).toBe(false);
  });
});

describe("signed download URLs", () => {
  const fileId = randomUUID();
  const userId = randomUUID();

  it("accepts a freshly issued token for the matching file", () => {
    const token = createSignedFileToken(fileId, userId, 60);
    const verified = verifySignedFileToken(token, fileId);
    expect(verified?.userId).toBe(userId);
  });

  it("rejects another file's token, tampering and expiry", () => {
    const token = createSignedFileToken(fileId, userId, 60);
    expect(verifySignedFileToken(token, randomUUID())).toBeNull();
    const [payload, signature] = token.split(".");
    const forgedPayload = Buffer.from(`${randomUUID()}.${userId}.${Math.floor(Date.now() / 1000) + 60}`).toString("base64url");
    expect(verifySignedFileToken(`${forgedPayload}.${signature}`, fileId)).toBeNull();
    expect(verifySignedFileToken(`${payload}.${signature}x`, fileId)).toBeNull();
    const expired = Buffer.from(`${fileId}.${userId}.${Math.floor(Date.now() / 1000) - 10}`).toString("base64url");
    const expiredToken = `${expired}.${hmacHex(process.env.STORAGE_SIGNING_SECRET!, Buffer.from(expired, "base64url").toString(), "sha256")}`;
    expect(verifySignedFileToken(expiredToken, fileId)).toBeNull();
  });
});
