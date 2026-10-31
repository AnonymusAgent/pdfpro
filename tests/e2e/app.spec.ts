import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { getPageText, openPdf, releasePdf } from "../../src/lib/pdf/pdfjs";

const fixture = (name: string) => join(process.cwd(), "tests/fixtures", name);

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function openSampleInEditor(page: Page) {
  await page.goto("/editor");
  await page.getByRole("button", { name: "Open sample document" }).click();
  await expect(page.locator('canvas[aria-label="Page 1"]')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/Page 1 \/ 2/).first()).toBeVisible({ timeout: 20_000 }).catch(async (e) => {
    console.log("EDITOR DIAGNOSTIC:", (await page.locator("footer").allInnerTexts()).join(" | "), "| body:", (await page.locator("body").innerText()).slice(0, 600));
    throw e;
  });
}

test("home page renders the workspace and the tool directory filters", async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Edit PDFs like a pro/ })).toBeVisible();
  await page.getByLabel("Search tools").fill("sign");
  await expect(page.getByRole("heading", { name: "Sign & Secure" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Compare" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("unknown routes show the branded 404 page, and the health endpoint responds", async ({ page, request }) => {
  await page.goto("/this-page-does-not-exist");
  await expect(page.getByText("This page does not exist")).toBeVisible();
  const health = await request.get("/api/health");
  expect(health.ok()).toBeTruthy();
  expect(await health.json()).toEqual({ ok: true });
});

test("every primary route renders its page heading", async ({ page }) => {
  const routes: [string, RegExp][] = [
    ["/convert", /Conversion center/],
    ["/ocr", /OCR workspace/],
    ["/tools", /Merge, split & compress/],
    ["/sign", /Sign & secure/],
    ["/compare", /Compare PDFs/],
    ["/recent", /Recent/],
    ["/settings", /Settings/],
    ["/help", /Help, shortcuts/],
  ];
  for (const [path, heading] of routes) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading }).first(), `heading on ${path}`).toBeVisible();
  }
});

test("editor opens the sample, renders pages and finds text", async ({ page }) => {
  const errors = collectPageErrors(page);
  await openSampleInEditor(page);
  const find = page.getByPlaceholder("Find (Ctrl/Cmd+F)");
  await find.fill("revenue");
  await find.fill("revenue");
  await find.press("Enter");
  await expect(page.getByText(/^1\/\d+/).first()).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("adds a text box, exports the edited PDF, and the exported file contains the new text", async ({ page }) => {
  const errors = collectPageErrors(page);
  await openSampleInEditor(page);
  await page.getByRole("button", { name: "Add text", exact: true }).click();
  await page.locator('[data-page-index="0"]').click({ position: { x: 150, y: 220 } });
  const editor = page.locator('textarea[aria-label="Edit text"]');
  await expect(editor).toBeVisible();
  await editor.fill("E2E inserted note");
  await editor.press("Escape");
  await page.getByRole("button", { name: "Export…", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export edited PDF", exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-edited\.pdf$/);
  const bytes = new Uint8Array(readFileSync((await download.path())!));
  expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
  const pdf = await openPdf(bytes);
  const text = (await getPageText(await pdf.getPage(1))).text;
  releasePdf(pdf);
  expect(text).toContain("E2E inserted note");
  expect(text).toContain("Quarterly revenue");
  expect(errors).toEqual([]);
});

test("converts a PDF table to XLSX and the download is a real spreadsheet", async ({ page }) => {
  await page.goto("/convert");
  await page.locator('input[type="file"]').first().setInputFiles(fixture("sample-report.pdf"));
  await page.getByRole("button", { name: /PDF → Excel \(XLSX\)/ }).click();
  await page.getByRole("button", { name: "Convert", exact: true }).click();
  await expect(page.getByText(/· verified \(/)).toBeVisible({ timeout: 90_000 });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download", exact: true }).first().click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  const zip = await JSZip.loadAsync(readFileSync((await download.path())!));
  expect(zip.file("xl/workbook.xml")).not.toBeNull();
  const strings = await zip.file("xl/sharedStrings.xml")!.async("string");
  expect(strings).toContain("North");
  expect(strings).toContain("Q1 revenue");
});

test("runs OCR on a scanned image in the browser and reports results", async ({ page }) => {
  test.setTimeout(300_000);
  const logs: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`.slice(0, 400));
  });
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`.slice(0, 400)));
  page.on("requestfailed", (r) => logs.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`));
  await page.goto("/ocr");
  await page.locator('input[type="file"]').first().setInputFiles(fixture("sample-scan.png"));
  await page.getByRole("button", { name: "Run OCR", exact: true }).click();
  await expect(page.getByText(/Done · 1 p/).or(page.getByText(/^Error$/))).toBeVisible({ timeout: 150_000 }).catch(async (e) => {
    console.log("OCR DIAGNOSTIC:", (await page.locator("main").innerText()).slice(0, 1200));
    throw e;
  });
  await expect(page.getByText(/Done · 1 p/)).toBeVisible().catch(async (e) => {
    console.log("OCR STATE:", (await page.locator("main").innerText()).slice(0, 900));
    throw e;
  });
  await expect(page.getByLabel("Recognized text (editable)")).toBeVisible();
});

test("the extension page builds a loadable Manifest V3 package", async ({ page }) => {
  await page.goto("/extension");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /Download extension ZIP/ }).click(),
  ]);
  const zip = await JSZip.loadAsync(readFileSync((await download.path())!));
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toEqual(expect.arrayContaining(["contextMenus", "storage"]));
  expect(manifest.permissions).not.toContain("<all_urls>");
  expect(manifest.icons["128"]).toBe("icons/icon128.png");
  expect(zip.file("icons/icon16.png")).not.toBeNull();
  expect(zip.file("background.js")).not.toBeNull();
});

test("the theme choice persists across reloads", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});
