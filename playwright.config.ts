import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against the production build (`npm run build`), served on a dedicated port
 * so they never interfere with the preview server or a developer's `next dev` session.
 */
const PORT = 3100;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    acceptDownloads: true,
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
