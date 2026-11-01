#!/usr/bin/env node
/**
 * Local development database.
 *
 * Starts an embedded PostgreSQL (PGlite, WASM) and exposes it over the
 * PostgreSQL wire protocol so the application can connect with `pg`/Drizzle
 * exactly as it would to a managed server.
 *
 *   npm run db:dev        # terminal 1 — database on 127.0.0.1:5432
 *   npm run db:migrate    # terminal 2 — create/upgrade the schema
 *   npm run dev           # terminal 2 — the app
 *
 * This is a development convenience only. Production must use a real
 * PostgreSQL server (Supabase, RDS, Cloud SQL, Neon, or self-hosted).
 */
import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const port = Number(process.env.PGLITE_PORT ?? 5432);
const host = process.env.PGLITE_HOST ?? "127.0.0.1";
const dataDir = process.env.PGLITE_DIR ?? join(process.cwd(), ".data", "pglite");

await mkdir(dataDir, { recursive: true });
const db = await PGlite.create({ dataDir });

// Several pooled clients (the app, scripts and tests) share this socket.
const maxConnections = Number(process.env.PGLITE_MAX_CONNECTIONS ?? 40);
const server = new PGLiteSocketServer({ db, port, host, maxConnections });
await server.start();

console.log(`PDF Pro development database ready`);
console.log(`  postgresql://postgres:postgres@${host}:${port}/postgres`);
console.log(`  data directory: ${dataDir}`);
console.log(`Press Ctrl+C to stop.`);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal} received — closing database.`);
  try {
    await server.stop();
  } finally {
    await db.close();
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
