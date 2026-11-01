import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against the production build (`npm run build`), served on a dedicated port
 * so they never interfere with the preview server or a developer's `next dev` session.
 *
 * The SaaS suite registers its own accounts, so the server runs with the console
 * mail transport and dev verification links enabled. Point DATABASE_URL at a
 * disposable database — the suite creates verified users and uploads files.
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
    env: {
      APP_URL: `http://127.0.0.1:${PORT}`,
      AUTH_SECRET: process.env.AUTH_SECRET ?? "e2e-auth-secret",
      AUTH_EXPOSE_DEV_LINKS: "true",
      EMAIL_TRANSPORT: "console",
      STORAGE_DIR: process.env.STORAGE_DIR ?? ".data/e2e-storage",
      STORAGE_SIGNING_SECRET: process.env.STORAGE_SIGNING_SECRET ?? "e2e-storage-secret",
      PG_POOL_MAX: "6",
    },
  },
});
