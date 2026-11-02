import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Client,
  createUser,
  db,
  grantAdmin,
  purgeTestUsers,
  resetRateLimits,
  revokeAdmin,
} from "./helpers";

const ADMIN_EMAILS: string[] = [];
let adminClient: Client | null = null;

async function createAdmin(): Promise<{ client: Client; email: string; userId: string }> {
  const user = await createUser({ displayName: "Admin Tester" });
  await grantAdmin(user.email);
  ADMIN_EMAILS.push(user.email);
  adminClient = user.client;
  return user;
}

beforeEach(async () => {
  await resetRateLimits();
  await purgeTestUsers();
});

afterEach(async () => {
  // Reset settings through the API so the server-side settings cache is
  // invalidated too (a raw SQL reset would leave a stale cache for a few
  // seconds and leak state into later suites).
  if (adminClient) {
    await adminClient.patch("/api/admin/settings", {
      billing: { paused: false, graceDays: 3, supportEmail: "billing@example.com" },
      adsense: { enabled: false, publisherId: "", slots: {}, requireConsent: true },
    });
    adminClient = null;
  }
  for (const email of ADMIN_EMAILS.splice(0)) await revokeAdmin(email);
  // Restore the seeded catalogue so other suites see the default prices.
  await db.query(
    "update subscription_plans set price_minor = 150000, compare_at_minor = null, active = true where id = 'premium_monthly'",
  );
  await db.query(
    "update subscription_plans set price_minor = 1500000, compare_at_minor = 1800000, active = true where id = 'premium_yearly'",
  );
  await db.query(
    `insert into settings (key, value) values ('adsense', '{"enabled":false,"publisherId":"","slots":{},"requireConsent":true}'::jsonb)
     on conflict (key) do update set value = excluded.value`,
  );
  await db.query(
    `insert into settings (key, value) values ('billing', '{"graceDays":3,"supportEmail":"billing@example.com","paused":false}'::jsonb)
     on conflict (key) do update set value = excluded.value`,
  );
});

afterAll(async () => {
  await purgeTestUsers();
  await db.end();
});

describe("admin authorisation", () => {
  it("lets only an administrator create a user without logging in as that user", async () => {
    const admin = await createAdmin();
    const email = "IT+" + Math.random().toString(36).slice(2) + "@example.test";
    const bad = await admin.client.post("/api/admin/users", { email, password: "short" });
    expect(bad.status).toBe(400);
    expect((bad.body as { code: string }).code).toBe("weak_password");

    const created = await admin.client.post<{ id: string; email: string; previewUrl?: string }>("/api/admin/users", {
      email, password: "Managed-Pass123", displayName: "Managed Tester",
    });
    expect(created.status).toBe(201);
    expect(created.body.email).toBe(email.toLowerCase());
    const duplicate = await admin.client.post("/api/admin/users", { email, password: "Managed-Pass123" });
    expect(duplicate.status).toBe(409);
    const adminSession = await admin.client.get<{ user: { id: string } }>("/api/auth/session");
    expect(adminSession.body.user.id).toBe(admin.userId);
    const newUser = new Client("managed");
    expect((await newUser.post("/api/auth/login", { email, password: "Managed-Pass123" })).status).toBe(200);
    const newSession = await newUser.get<{ user: { id: string; isAdmin: boolean; emailVerified: boolean } }>("/api/auth/session");
    expect(newSession.body.user.id).toBe(created.body.id);
    expect(newSession.body.user.isAdmin).toBe(false);
    expect(newSession.body.user.emailVerified).toBe(false);
  });

  it("rejects anonymous and non-admin callers on every admin route", async () => {
    const { client } = await createUser();
    const routes = [
      ["GET", "/api/admin/stats"],
      ["GET", "/api/admin/users"],
      ["POST", "/api/admin/users"],
      ["GET", "/api/admin/subscriptions"],
      ["GET", "/api/admin/payments"],
      ["GET", "/api/admin/outbox"],
      ["GET", "/api/admin/webhooks"],
      ["PATCH", "/api/admin/plans"],
      ["PATCH", "/api/admin/settings"],
    ] as const;

    for (const [method, path] of routes) {
      const anonymous = await new Client("anon").request(path, { method });
      expect(anonymous.status, `${method} ${path} anonymous`).toBe(401);
      const normal = await client.request(path, method === "PATCH" ? { method, json: {} } : { method });
      expect(normal.status, `${method} ${path} as user`).toBe(403);
    }
  });

  it("grants access once the role row exists and revokes it again", async () => {
    const { client, email } = await createUser();
    expect((await client.get("/api/admin/stats")).status).toBe(403);

    await grantAdmin(email);
    const stats = await client.get<{
      users: { total: number; free: number; premium: number };
      subscriptions: { active: number; pastDue: number };
      revenue: { currency: string; mrrMinor: number }[];
      payments: { succeeded: number; failed: number; total: number };
    }>("/api/admin/stats");
    expect(stats.status).toBe(200);
    expect(stats.body.users.total).toBeGreaterThanOrEqual(1);
    expect(typeof stats.body.users.premium).toBe("number");
    expect(typeof stats.body.subscriptions.active).toBe("number");
    expect(typeof stats.body.payments.total).toBe("number");
    expect(Array.isArray(stats.body.revenue)).toBe(true);

    await revokeAdmin(email);
    expect((await client.get("/api/admin/stats")).status).toBe(403);
  });

  it("never lets a user grant themselves admin", async () => {
    const { client } = await createUser();
    const attempt = await client.request("/api/admin/users", {
      method: "PATCH",
      json: { userId: "someone", action: "grant_admin" },
    });
    expect(attempt.status).toBe(403);
    const { rows } = await db.query("select count(*)::int as count from admin_roles");
    expect(rows[0].count).toBe(0);
  });
});

describe("admin operations", () => {
  it("edits prices and reflects them on the public pricing API", async () => {
    const { client } = await createAdmin();
    const updated = await client.patch<{ ok: boolean }>("/api/admin/plans", {
      id: "premium_monthly",
      priceMinor: 199_900,
      compareAtMinor: 249_900,
      name: "Premium Monthly",
    });
    expect(updated.status).toBe(200);

    const publicPlans = await new Client("public").get<{ plans: { id: string; priceMinor: number; compareAtMinor: number }[] }>(
      "/api/billing/plans",
    );
    const monthly = publicPlans.body.plans.find((plan) => plan.id === "premium_monthly")!;
    expect(monthly.priceMinor).toBe(199_900);
    expect(monthly.compareAtMinor).toBe(249_900);

    const rejected = await client.patch("/api/admin/plans", { id: "premium_monthly", priceMinor: -5 });
    expect(rejected.status).toBe(400);
  });

  it("enables AdSense only with a publisher id, and switches ads off again", async () => {
    const { client } = await createAdmin();
    const config = await new Client("ads").get<{ ads: { enabled: boolean; publisherId: string } }>("/api/site-config");
    expect(config.body.ads.enabled).toBe(false);
    expect(config.body.ads.publisherId).toBe("");

    const enabled = await client.patch("/api/admin/settings", {
      adsense: {
        enabled: true,
        publisherId: "ca-pub-1234567890123456",
        slots: { dashboard: "1234567890", cloud: "2345678901" },
        requireConsent: true,
      },
    });
    expect(enabled.status).toBe(200);

    const withAds = await new Client("ads2").get<{
      ads: { enabled: boolean; publisherId: string; slots: Record<string, string>; requireConsent: boolean };
    }>("/api/site-config");
    expect(withAds.body.ads.enabled).toBe(true);
    expect(withAds.body.ads.publisherId).toBe("ca-pub-1234567890123456");
    expect(withAds.body.ads.slots.dashboard).toBe("1234567890");

    const cleared = await client.patch("/api/admin/settings", { adsense: { enabled: true, publisherId: "" } });
    expect(cleared.status).toBe(200);
    const afterClear = await new Client("ads3").get<{ ads: { enabled: boolean } }>("/api/site-config");
    expect(afterClear.body.ads.enabled).toBe(false);
  });

  it("pauses checkout and updates the grace period", async () => {
    const { client } = await createAdmin();
    const paused = await client.patch<{ billing: { paused: boolean; graceDays: number } }>("/api/admin/settings", {
      billing: { paused: true, graceDays: 7, supportEmail: "support@example.test" },
    });
    expect(paused.status).toBe(200);
    expect(paused.body.billing.paused).toBe(true);
    expect(paused.body.billing.graceDays).toBe(7);

    const publicPlans = await new Client("public").get<{ checkout: { available: boolean; reason: string | null } }>(
      "/api/billing/plans",
    );
    expect(publicPlans.body.checkout.available).toBe(false);
    expect(publicPlans.body.checkout.reason).toContain("paused");

    const { client: buyer } = await createUser();
    const checkout = await buyer.post<{ code: string }>("/api/billing/checkout", { planId: "premium_monthly" });
    expect(checkout.status).toBe(503);
    expect(checkout.body.code).toBe("billing_paused");

    const invalid = await client.patch("/api/admin/settings", { billing: { graceDays: 99 } });
    expect(invalid.status).toBe(400);
  });

  it("suspends and reactivates a user, and blocks their sign-in while suspended", async () => {
    const admin = await createAdmin();
    const victim = await createUser();

    const suspended = await admin.client.request<{ ok: boolean }>("/api/admin/users", {
      method: "PATCH",
      json: { userId: victim.userId, action: "suspend" },
    });
    expect(suspended.status).toBe(200);

    expect((await victim.client.get<{ user: unknown }>("/api/auth/session")).body.user).toBeNull();
    const login = await new Client("victim").post<{ code: string }>("/api/auth/login", {
      email: victim.email,
      password: victim.password,
    });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe("account_suspended");

    const reactivated = await admin.client.request("/api/admin/users", {
      method: "PATCH",
      json: { userId: victim.userId, action: "activate" },
    });
    expect(reactivated.status).toBe(200);
    const back = await new Client("victim").post("/api/auth/login", { email: victim.email, password: victim.password });
    expect(back.status).toBe(200);
  });

  it("lists users with search and shows aggregated metrics", async () => {
    const admin = await createAdmin();
    const target = await createUser({ displayName: "Searchable Person" });

    const search = await admin.client.get<{ users: { email: string }[] }>("/api/admin/users?q=searchable");
    expect(search.status).toBe(200);
    expect(search.body.users.some((user) => user.email === target.email)).toBe(true);

    const stats = await admin.client.get<{
      users: { total: number };
      storage: { files: number; bytes: number };
      webhooks: { total: number };
    }>("/api/admin/stats");
    expect(stats.body.users.total).toBeGreaterThanOrEqual(2);
    expect(typeof stats.body.storage.bytes).toBe("number");
    expect(typeof stats.body.webhooks.total).toBe("number");
  });

  it("hides the admin page from signed-in non-admins", async () => {
    const { client } = await createUser();
    const response = await client.get("/admin");
    expect(response.status).toBe(200);
    expect(String(response.body)).toContain("Administrator access required");
  });
});
