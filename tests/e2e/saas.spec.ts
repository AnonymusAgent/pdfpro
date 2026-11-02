/**
 * End-to-end coverage for the SaaS surfaces: authentication, dashboard, cloud
 * file manager, pricing, account settings and the admin gate.
 *
 * The suite seeds verified test users into a disposable database as an
 * operator, then drives the UI with a real browser. Public registration is closed.
 *
 *   npm run build && npm run test:e2e
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { join } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import pg from "pg";

const fixture = (name: string) => join(process.cwd(), "tests/fixtures", name);
const PASSWORD = "Playwright-Pass1";

function uniqueEmail(label: string): string {
  return `pw-${label}-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.test`;
}

/** Only use a disposable DATABASE_URL: create a verified test account outside the public API. */
async function createVerifiedUser(
  _request: APIRequestContext,
  label = "user",
): Promise<{ email: string; password: string; userId: string }> {
  const email = uniqueEmail(label);
  const salt = randomBytes(16);
  const hash = scryptSync(PASSWORD, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 16384 * 8 * 2 });
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      "insert into users (email, email_normalized, password_hash, email_verified_at) values ($1, $1, $2, now()) returning id",
      [email, `scrypt$16384$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`],
    );
    const userId = rows[0]!.id;
    await client.query("insert into profiles (user_id) values ($1)", [userId]);
    await client.query("insert into storage_usage (user_id) values ($1)", [userId]);
    return { email, password: PASSWORD, userId };
  } finally {
    await client.end();
  }
}

async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
}

test.describe("authentication", () => {
  test("protected pages redirect to the sign-in screen", async ({ page }) => {
    for (const path of ["/dashboard", "/cloud", "/account", "/admin"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login\?next=/);
      await expect(page.getByRole("heading", { name: /Sign in/i })).toBeVisible();
    }
  });

  test("visitors cannot create accounts", async ({ page, request }) => {
    await page.goto("/register");
    await expect(page.getByText(/accounts are created by an administrator/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Create free account/i })).toHaveCount(0);
    const blocked = await request.post("/api/auth/register", { data: { email: uniqueEmail("blocked"), password: PASSWORD } });
    expect(blocked.status()).toBe(403);
    await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
  });

  test("sign in, sign out and password reset screens work", async ({ page, request }) => {
    const user = await createVerifiedUser(request, "signin");
    await signIn(page, user.email);

    await page.goto("/account");
    await expect(page.getByRole("heading", { name: /Account/i }).first()).toBeVisible();

    const logout = page.getByRole("button", { name: /sign out/i }).first();
    await logout.click();
    await expect(page).toHaveURL(/\/$|\/login/, { timeout: 20_000 });

    const forgot = await request.post("/api/auth/forgot-password", { data: { email: user.email } });
    const resetBody = (await forgot.json()) as { previewUrl?: string };
    const token = new URL(resetBody.previewUrl!).searchParams.get("token")!;
    await page.goto(`/reset-password?token=${token}`);
    await page.getByLabel("New password").fill("Playwright-Pass2");
    await page.getByLabel("Confirm new password").fill("Playwright-Pass2");
    await page.getByRole("button", { name: /Update password/i }).click();
    await expect(page.getByText(/password/i).first()).toBeVisible({ timeout: 20_000 });

    await signIn(page, user.email, "Playwright-Pass2");
  });
});

test.describe("dashboard, pricing and cloud storage", () => {
  test("pricing page lists both plans with a Free vs Premium comparison", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByRole("heading", { name: /Free vs Premium/i })).toBeVisible();
    await expect(page.getByText("Free", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Premium", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/200 MB/i).first()).toBeVisible();
    await expect(page.getByText(/Monthly/i).first()).toBeVisible();
    await expect(page.getByText(/Yearly/i).first()).toBeVisible();
  });

  test("the dashboard shows plan, storage usage and recent files", async ({ page, request }) => {
    const user = await createVerifiedUser(request, "dash");
    await signIn(page, user.email);

    await expect(page.getByRole("heading", { name: "Dashboard" }).first()).toBeVisible();
    await expect(page.getByText("Storage", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Recent files", { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/Free plan/i).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Upgrade|Compare plans/i }).first()).toBeVisible();
  });

  test("a PDF can be uploaded, renamed, downloaded and deleted in the cloud manager", async ({ page, request }) => {
    const user = await createVerifiedUser(request, "cloud");
    await signIn(page, user.email);
    await page.goto("/cloud");

    await expect(page.getByRole("heading", { name: /Your files/i }).first()).toBeVisible();
    await page.locator('input[type="file"]').first().setInputFiles(fixture("sample-report.pdf"));
    await expect(page.getByText("sample-report.pdf").first()).toBeVisible({ timeout: 45_000 });

    await page.getByRole("button", { name: "Rename file" }).first().click();
    const nameField = page.getByRole("textbox").first();
    await nameField.fill("renamed-report");
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page.getByText("renamed-report.pdf").first()).toBeVisible({ timeout: 20_000 });

    const download = page.waitForEvent("download", { timeout: 30_000 });
    await page.getByRole("button", { name: "Download" }).first().click();
    expect((await download).suggestedFilename()).toContain("renamed-report");

    await page.getByRole("button", { name: "Delete file" }).first().click();
    await page.getByRole("button", { name: /Delete file|Delete/ }).last().click();
    await expect(page.getByText("No files yet").first()).toBeVisible({ timeout: 20_000 });
  });

  test("search and sort stay server-side and survive a reload", async ({ page, request }) => {
    const user = await createVerifiedUser(request, "search");
    await signIn(page, user.email);
    await page.goto("/cloud");
    await page.locator('input[type="file"]').first().setInputFiles(fixture("sample-report.pdf"));
    await expect(page.getByText("sample-report.pdf").first()).toBeVisible({ timeout: 45_000 });

    await page.getByLabel("Search files").fill("nothing-matches-this");
    await expect(page.getByText("No files match that search").first()).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Search files").fill("sample");
    await expect(page.getByText("sample-report.pdf").first()).toBeVisible({ timeout: 20_000 });

    await page.reload();
    await expect(page.getByText("sample-report.pdf").first()).toBeVisible({ timeout: 20_000 });
  });
});

test.describe("account and admin", () => {
  test("profile details and devices are managed from the account page", async ({ page, request }) => {
    const user = await createVerifiedUser(request, "account");
    await signIn(page, user.email);
    await page.goto("/account?tab=profile");

    await expect(page.getByRole("heading", { name: /Account/i }).first()).toBeVisible();
    const companyField = page.getByLabel(/Company/i).first();
    if (await companyField.count()) {
      await companyField.fill("Playwright Labs");
      await page.getByRole("button", { name: /Save|Update profile/i }).first().click();
      await expect(page.getByText(/Profile updated/i).first()).toBeVisible({ timeout: 20_000 });
      await page.reload();
      await expect(page.getByLabel(/Company/i).first()).toHaveValue("Playwright Labs");
    }

    await page.getByRole("tab", { name: /Devices/i }).or(page.getByRole("button", { name: /Devices/i })).first().click();
    await expect(page.getByText(/Signed-in devices/i).first()).toBeVisible();
  });

  test("the billing tab shows the current plan and payment history", async ({ page, request }) => {
    const user = await createVerifiedUser(request, "billing");
    await signIn(page, user.email);
    await page.goto("/account?tab=billing");
    await expect(page.getByText("Payment history", { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/Free plan|No payments yet/i).first()).toBeVisible();
  });

  test("non-administrators see the access notice instead of the admin dashboard", async ({ page, request }) => {
    const user = await createVerifiedUser(request, "nonadmin");
    await signIn(page, user.email);
    await page.goto("/admin");
    await expect(page.getByText(/Administrator access required/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: /Overview/i })).toHaveCount(0);
  });

  test("free accounts never load AdSense when it is not configured", async ({ page, request }) => {
    const user = await createVerifiedUser(request, "ads");
    await signIn(page, user.email);
    for (const path of ["/dashboard", "/cloud", "/pricing"]) {
      await page.goto(path);
      await expect(page.locator("ins.adsbygoogle")).toHaveCount(0);
      await expect(page.locator('script[src*="pagead2.googlesyndication.com"]')).toHaveCount(0);
    }
  });
});

test("the PDF tools keep working for signed-in users", async ({ page, request }) => {
  const user = await createVerifiedUser(request, "tools");
  await signIn(page, user.email);
  await page.goto("/editor");
  await expect(page.getByRole("button", { name: "Open sample document" })).toBeVisible();
  await page.getByRole("button", { name: "Open sample document" }).click();
  await expect(page.locator('canvas[aria-label="Page 1"]')).toBeVisible({ timeout: 45_000 });
});
