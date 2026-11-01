/**
 * End-to-end coverage for the SaaS surfaces: authentication, dashboard, cloud
 * file manager, pricing, account settings and the admin gate.
 *
 * The suite registers its own verified accounts through the JSON API (the
 * console mail transport exposes the verification link when
 * AUTH_EXPOSE_DEV_LINKS=true) and then drives the UI with a real browser.
 *
 *   npm run build && npm run test:e2e
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { join } from "node:path";

const fixture = (name: string) => join(process.cwd(), "tests/fixtures", name);
const PASSWORD = "Playwright-Pass1";

function uniqueEmail(label: string): string {
  return `pw-${label}-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.test`;
}

/** Registers + verifies an account through the API and returns its credentials. */
async function createVerifiedUser(
  request: APIRequestContext,
  label = "user",
): Promise<{ email: string; password: string; userId: string }> {
  const email = uniqueEmail(label);
  const registered = await request.post("/api/auth/register", {
    data: { email, password: PASSWORD, displayName: "Playwright Tester" },
  });
  expect(registered.status(), await registered.text()).toBe(201);
  const body = (await registered.json()) as { previewUrl?: string; user: { id: string } };
  const token = body.previewUrl ? new URL(body.previewUrl).searchParams.get("token") : null;
  expect(token, "AUTH_EXPOSE_DEV_LINKS must expose the verification link for e2e tests").toBeTruthy();
  const verified = await request.post("/api/auth/verify-email", { data: { token } });
  expect(verified.status()).toBe(200);
  return { email, password: PASSWORD, userId: body.user.id };
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
      await expect(page.getByRole("heading", { name: /Welcome back/i })).toBeVisible();
    }
  });

  test("a visitor can register, verify and reach the dashboard", async ({ page, request }) => {
    const email = uniqueEmail("register");
    await page.goto("/register");
    await page.getByLabel(/^Name/).fill("Playwright Tester");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: /Create free account/i }).click();

    // Registration redirects to the dashboard with the dev-only verification link.
    await expect(page.getByRole("heading", { name: "Dashboard" }).first()).toBeVisible({ timeout: 30_000 });
    const verifyLink = page.getByRole("link", { name: /verify-email\?token=/ }).first();
    await expect(verifyLink).toBeVisible({ timeout: 20_000 });
    await verifyLink.click();
    await expect(page.getByRole("heading", { name: /Verify email/i })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/verified/i).first()).toBeVisible({ timeout: 30_000 });
    void request;
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
