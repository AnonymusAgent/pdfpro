/**
 * Boots the production build for the integration tests.
 *
 * Starts `next start` on 127.0.0.1:3300 with a deterministic test environment,
 * waits for /api/health, and shuts the server down afterwards.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";

const PORT = 3300;
const BASE_URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess | null = null;

async function waitForHealth(timeoutMs = 120_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The application did not become healthy in time.");
}

async function alreadyRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  const databaseUrl = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

  execFileSync("node", ["scripts/migrate.mjs"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  await mkdir(".data/test-storage", { recursive: true });

  // Reuse a server that is already listening (handy while iterating locally);
  // otherwise start one from the production build and stop it afterwards.
  if (await alreadyRunning()) {
    console.info(`[integration] reusing the server already running on ${BASE_URL}`);
    return async () => {};
  }

  server = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: databaseUrl,
      APP_URL: BASE_URL,
      AUTH_SECRET: "it-auth-secret",
      AUTH_EXPOSE_DEV_LINKS: "true",
      EMAIL_TRANSPORT: "console",
      STORAGE_DIR: ".data/test-storage",
      STORAGE_SIGNING_SECRET: "it-storage-secret",
      SAFEPAY_ENV: "sandbox",
      SAFEPAY_API_KEY: "sec_it_api_key",
      SAFEPAY_SECRET_KEY: "sec_it_secret_key",
      SAFEPAY_WEBHOOK_SECRET: "it-webhook-secret",
      SAFEPAY_V1_SECRET: "it-v1-secret",
      CRON_SECRET: "it-cron-secret",
      ADMIN_EMAILS: "",
    },
  });

  server.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[next] ${chunk.toString()}`));
  server.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[next] ${chunk.toString()}`));

  await waitForHealth();

  return async () => {
    if (!server) return;
    server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (!server.killed) server.kill("SIGKILL");
    server = null;
  };
}
