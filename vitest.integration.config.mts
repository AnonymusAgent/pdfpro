import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * HTTP integration tests.
 *
 * These run against the production build (`npm run build` first) served by
 * `next start` on port 3300, talking to the real PostgreSQL database in
 * DATABASE_URL. They exercise authentication, storage, quota enforcement,
 * payments and admin authorisation end to end over HTTP.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 180_000,
    env: {
      IT_BASE_URL: process.env.IT_BASE_URL ?? "http://127.0.0.1:3300",
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
      SAFEPAY_WEBHOOK_SECRET: "it-webhook-secret",
      CRON_SECRET: "it-cron-secret",
    },
  },
});
