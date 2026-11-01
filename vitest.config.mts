import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: {
      // Unit tests never connect to a database, but modules import the pool
      // module at load time, which requires the variable to exist.
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
      AUTH_SECRET: "unit-test-secret",
      STORAGE_SIGNING_SECRET: "unit-test-storage-secret",
      SAFEPAY_WEBHOOK_SECRET: "unit-test-webhook-secret",
      SAFEPAY_V1_SECRET: "unit-test-v1-secret",
      SAFEPAY_API_KEY: "sec_test_api_key",
      SAFEPAY_SECRET_KEY: "sec_test_secret_key",
      EMAIL_TRANSPORT: "console",
    },
  },
});
