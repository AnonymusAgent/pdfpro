import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  Client,
  createUser,
  db,
  makePdf,
  paymentWebhook,
  purgeTestUsers,
  resetRateLimits,
  seedPendingCheckout,
  signWebhook,
} from "./helpers";

const WEBHOOK = "/api/payments/safepay/webhook";
const MAINTENANCE = "/api/cron/maintenance";

async function deliver(body: string, signature: string | null = signWebhook(body)) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature) headers["x-sfpy-signature"] = signature;
  return fetch(`${new URL(WEBHOOK, process.env.IT_BASE_URL ?? "http://127.0.0.1:3300")}`, {
    method: "POST",
    headers,
    body,
  });
}

async function runMaintenance(): Promise<number> {
  const response = await fetch(`${new URL(MAINTENANCE, process.env.IT_BASE_URL ?? "http://127.0.0.1:3300")}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? "it-cron-secret"}`, Origin: process.env.IT_BASE_URL ?? "http://127.0.0.1:3300" },
  });
  return response.status;
}

type Session = {
  user: { plan: string; emailVerified: boolean } | null;
  entitlements: { plan: string; quotaBytes: number; storage: { usedBytes: number; uploadsBlocked: boolean } };
};

beforeEach(async () => {
  await resetRateLimits();
  await purgeTestUsers();
});

afterAll(async () => {
  await purgeTestUsers();
  await db.end();
});

describe("plan catalogue", () => {
  it("serves both plans with database prices and the 10 GB quota", async () => {
    const response = await new Client("catalogue").get<{
      plans: { id: string; interval: string; priceMinor: number; currency: string; storageBytes: number; active: boolean }[];
      currency: string;
      checkout: { available: boolean; provider: string };
    }>("/api/billing/plans");
    expect(response.status).toBe(200);
    const monthly = response.body.plans.find((plan) => plan.id === "premium_monthly")!;
    const yearly = response.body.plans.find((plan) => plan.id === "premium_yearly")!;
    expect(monthly.priceMinor).toBe(150_000);
    expect(monthly.currency).toBe("PKR");
    expect(monthly.storageBytes).toBe(10_000_000_000);
    expect(yearly.priceMinor).toBe(1_500_000);
    expect(yearly.interval).toBe("year");
    expect(response.body.checkout.provider).toBe("safepay");
  });

  it("rejects unknown plans before contacting the payment provider", async () => {
    const { client } = await createUser();
    const response = await client.post<{ code: string }>("/api/billing/checkout", { planId: "not_a_plan" });
    expect(response.status).toBe(404);
  });
});

describe("verified webhooks activate Premium", () => {
  it("activates Premium only for a signed, amount-matching payment", async () => {
    const { client, userId } = await createUser();
    const { tracker } = await seedPendingCheckout({ userId });

    const before = await client.get<Session>("/api/auth/session");
    expect(before.body.entitlements.plan).toBe("free");

    const payload = paymentWebhook({ tracker, amountMinor: 150_000 });
    const delivered = await deliver(payload.body);
    expect(delivered.status).toBe(200);
    expect((await delivered.json()).outcome).toBe("activated");

    const after = await client.get<Session>("/api/auth/session");
    expect(after.body.user?.plan).toBe("premium");
    expect(after.body.entitlements.plan).toBe("premium");
    expect(after.body.entitlements.quotaBytes).toBe(10_000_000_000);

    const { rows } = await db.query<{ status: string; current_period_end: Date }>(
      "select status, current_period_end from subscriptions where user_id = $1 order by created_at desc limit 1",
      [userId],
    );
    expect(rows[0]!.status).toBe("active");
    expect(new Date(rows[0]!.current_period_end).getTime()).toBeGreaterThan(Date.now());

    const payment = await db.query<{ status: string; paid_at: Date | null }>(
      "select status, paid_at from payments where user_id = $1 order by created_at desc limit 1",
      [userId],
    );
    expect(payment.rows[0]!.status).toBe("succeeded");
    expect(payment.rows[0]!.paid_at).toBeTruthy();

    const event = await db.query<{ signature_valid: boolean; status: string }>(
      "select signature_valid, status from payment_webhook_events where event_id = $1",
      [payload.eventId],
    );
    expect(event.rows[0]!.signature_valid).toBe(true);
    expect(event.rows[0]!.status).toBe("processed");
  });

  it("is idempotent for repeated deliveries of the same event", async () => {
    const { client, userId } = await createUser();
    const { tracker } = await seedPendingCheckout({ userId });
    const payload = paymentWebhook({ tracker, amountMinor: 150_000 });

    expect((await deliver(payload.body)).status).toBe(200);
    const { rows: first } = await db.query<{ current_period_end: Date }>(
      "select current_period_end from subscriptions where user_id = $1",
      [userId],
    );

    const replay = await deliver(payload.body);
    expect(replay.status).toBe(200);
    expect((await replay.json()).duplicate).toBe(true);

    const { rows: second } = await db.query<{ current_period_end: Date }>(
      "select current_period_end from subscriptions where user_id = $1",
      [userId],
    );
    expect(new Date(second[0]!.current_period_end).toISOString()).toBe(
      new Date(first[0]!.current_period_end).toISOString(),
    );

    // A new event id for an already-paid tracker must not extend the term either.
    const duplicatePayment = paymentWebhook({ tracker, amountMinor: 150_000 });
    const again = await deliver(duplicatePayment.body);
    expect((await again.json()).outcome).toBe("duplicate");
    expect((await client.get<Session>("/api/auth/session")).body.entitlements.plan).toBe("premium");
  });

  it("rejects unsigned webhooks and never activates Premium from them", async () => {
    const { client, userId } = await createUser();
    const { tracker } = await seedPendingCheckout({ userId });
    const payload = paymentWebhook({ tracker, amountMinor: 150_000 });

    const unsigned = await deliver(payload.body, null);
    expect(unsigned.status).toBe(401);

    // A fresh event id with a wrong signature is rejected outright.
    const forgedPayload = paymentWebhook({ tracker, amountMinor: 150_000 });
    const forged = await deliver(forgedPayload.body, "0".repeat(128));
    expect(forged.status).toBe(401);

    expect((await client.get<Session>("/api/auth/session")).body.entitlements.plan).toBe("free");
    const payment = await db.query<{ status: string }>("select status from payments where user_id = $1", [userId]);
    expect(payment.rows[0]!.status).toBe("pending");

    // The same tracker can still be activated later by a correctly signed event.
    const signed = paymentWebhook({ tracker, amountMinor: 150_000 });
    expect((await deliver(signed.body)).status).toBe(200);
    expect((await client.get<Session>("/api/auth/session")).body.entitlements.plan).toBe("premium");
  });

  it("refuses to grant Premium when the verified amount does not match", async () => {
    const { client, userId } = await createUser();
    const { tracker } = await seedPendingCheckout({ userId, amountMinor: 150_000 });

    const payload = paymentWebhook({ tracker, amountMinor: 100 });
    const delivered = await deliver(payload.body);
    expect(delivered.status).toBe(200);
    expect((await delivered.json()).outcome).toBe("amount_mismatch");

    expect((await client.get<Session>("/api/auth/session")).body.entitlements.plan).toBe("free");
    const payment = await db.query<{ status: string; failure_reason: string }>(
      "select status, failure_reason from payments where user_id = $1",
      [userId],
    );
    expect(payment.rows[0]!.status).toBe("failed");
    expect(payment.rows[0]!.failure_reason).toContain("amount_mismatch");
  });
});

describe("subscription lifecycle", () => {
  it("keeps Premium through the grace period after a failed payment, then restores Free", async () => {
    const { client, userId } = await createUser();
    const upload = await client.upload(await makePdf("Keep me"), "keep-me.pdf");
    expect(upload.status).toBe(201);

    const { tracker } = await seedPendingCheckout({ userId });
    expect((await deliver(paymentWebhook({ tracker, amountMinor: 150_000 }).body)).status).toBe(200);
    expect((await client.get<Session>("/api/auth/session")).body.entitlements.plan).toBe("premium");

    const failed = paymentWebhook({ tracker, amountMinor: 150_000, state: "FAILED" });
    const failureBody = failed.body.replace('"payment:created"', '"payment:failed"');
    expect((await deliver(failureBody)).status).toBe(200);

    const { rows: failedRows } = await db.query<{ status: string }>(
      "select status from subscriptions where user_id = $1",
      [userId],
    );
    expect(failedRows[0]!.status).toBe("past_due");

    // Grace keeps the higher quota while the retry is pending.
    const grace = await client.get<Session>("/api/auth/session");
    expect(grace.body.entitlements.plan).toBe("premium");

    await db.query("update subscriptions set grace_until = now() - interval '1 minute' where user_id = $1", [userId]);
    expect(await runMaintenance()).toBe(200);

    const after = await client.get<Session>("/api/auth/session");
    expect(after.body.entitlements.plan).toBe("free");
    expect(after.body.entitlements.quotaBytes).toBe(2_000_000_000);

    // Files are preserved after the downgrade, only new uploads beyond 2 GB stop.
    const files = await client.get<{ files: { name: string }[] }>("/api/files");
    expect(files.body.files.map((file) => file.name)).toContain("keep-me.pdf");
    const download = await client.get(`/api/files/${(upload.body as { file: { id: string } }).file.id}/download`);
    expect(download.status).toBe(200);
  });

  it("expires a lapsed subscription and returns the account to Free with files intact", async () => {
    const { client, userId } = await createUser();
    await client.upload(await makePdf("Still here"), "still-here.pdf");
    const { tracker } = await seedPendingCheckout({ userId });
    await deliver(paymentWebhook({ tracker, amountMinor: 150_000 }).body);

    await db.query("update subscriptions set current_period_end = now() - interval '1 day' where user_id = $1", [userId]);
    expect(await runMaintenance()).toBe(200);

    const session = await client.get<Session>("/api/auth/session");
    expect(session.body.entitlements.plan).toBe("free");
    expect(session.body.entitlements.quotaBytes).toBe(2_000_000_000);
    const files = await client.get<{ total: number }>("/api/files");
    expect(files.body.total).toBe(1);
  });

  it("cancels at period end, keeping Premium until the paid term ends", async () => {
    const { client, userId } = await createUser();
    const { tracker } = await seedPendingCheckout({ userId });
    await deliver(paymentWebhook({ tracker, amountMinor: 150_000 }).body);

    const cancelled = await client.post<{ status: string; message: string }>("/api/billing/cancel", {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled_at_period_end");

    expect((await client.get<Session>("/api/auth/session")).body.entitlements.plan).toBe("premium");

    await db.query("update subscriptions set current_period_end = now() - interval '1 hour' where user_id = $1", [userId]);
    await runMaintenance();
    const after = await client.get<Session>("/api/auth/session");
    expect(after.body.entitlements.plan).toBe("free");

    const again = await client.post("/api/billing/cancel", {});
    expect(again.status).toBe(404);
  });

  it("ends Premium when a verified refund arrives", async () => {
    const { client, userId } = await createUser();
    const { tracker } = await seedPendingCheckout({ userId });
    await deliver(paymentWebhook({ tracker, amountMinor: 150_000 }).body);
    expect((await client.get<Session>("/api/auth/session")).body.entitlements.plan).toBe("premium");

    const refund = JSON.stringify({
      token: `evt_refund_${Date.now()}`,
      type: "payment:refunded",
      notification: { tracker, state: "REFUNDED", amount: "1500.00", currency: "PKR" },
    });
    expect((await deliver(refund)).status).toBe(200);

    const payment = await db.query<{ status: string }>("select status from payments where user_id = $1", [userId]);
    expect(payment.rows[0]!.status).toBe("refunded");
    expect((await client.get<Session>("/api/auth/session")).body.entitlements.plan).toBe("free");
  });

  it("never activates Premium from the return URL alone", async () => {
    const { client, userId } = await createUser();
    const { paymentId, tracker } = await seedPendingCheckout({ userId });

    const unsigned = await client.post<{ status: string }>("/api/billing/verify-return", { paymentId, tracker });
    expect(unsigned.status).toBe(200);
    expect(unsigned.body.status).not.toBe("paid");

    const badSignature = await client.post<{ status: string }>("/api/billing/verify-return", {
      paymentId,
      tracker,
      signature: "deadbeef",
    });
    expect(badSignature.body.status).toBe("failed");

    expect((await client.get<Session>("/api/auth/session")).body.entitlements.plan).toBe("free");
    // Someone else's payment id is not readable either.
    const other = await createUser();
    const foreign = await other.client.post<{ status: string }>("/api/billing/verify-return", { paymentId, tracker });
    expect(foreign.body.status).toBe("unknown");
  });

  it("refuses a second checkout while Premium is active", async () => {
    const { client, userId } = await createUser();
    const { tracker } = await seedPendingCheckout({ userId });
    await deliver(paymentWebhook({ tracker, amountMinor: 150_000 }).body);

    const again = await client.post<{ code: string }>("/api/billing/checkout", { planId: "premium_monthly" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("already_subscribed");
  });

  it("shows payment history to the owner only", async () => {
    const { client, userId } = await createUser();
    const { tracker, paymentId } = await seedPendingCheckout({ userId });
    await deliver(paymentWebhook({ tracker, amountMinor: 150_000 }).body);

    const account = await client.get<{ payments: { id: string; status: string; amountMinor: number }[] }>("/api/account");
    expect(account.status).toBe(200);
    const payment = account.body.payments.find((row) => row.id === paymentId);
    expect(payment?.status).toBe("succeeded");
    expect(payment?.amountMinor).toBe(150_000);
  });
});

describe("maintenance endpoint", () => {
  it("requires the cron secret or an administrator", async () => {
    const anonymous = await fetch(new URL(MAINTENANCE, process.env.IT_BASE_URL ?? "http://127.0.0.1:3300"), {
      method: "POST",
    });
    expect(anonymous.status).toBe(401);

    const { client } = await createUser();
    const asUser = await client.post(MAINTENANCE, {});
    expect(asUser.status).toBe(401);
  });
});
