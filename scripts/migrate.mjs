#!/usr/bin/env node
/**
 * Migration runner for PDF Pro.
 *
 * Applies every `drizzle/*.sql` file once, in filename order, inside a
 * transaction, and records the result in `schema_migrations`.
 *
 *   npm run db:migrate          apply pending migrations
 *   npm run db:migrate -- --status   show what has been applied
 *
 * The runner is intentionally dependency-light (node-postgres only) so it can
 * run in CI, in a container entrypoint, or from a release job.
 */
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "drizzle");
const statusOnly = process.argv.includes("--status");

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || process.env.DATABASE_URL_POOLED || process.env.POSTGRES_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required (see .env.example).");
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();

try {
  await client.query(`
    create table if not exists schema_migrations (
      id text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await client.query("select id, checksum, applied_at from schema_migrations order by id");
  const applied = new Map(rows.map((r) => [r.id, r]));

  if (statusOnly) {
    for (const file of files) {
      const row = applied.get(file);
      console.log(`${row ? "applied" : "pending"}  ${file}${row ? `  (${row.applied_at.toISOString()})` : ""}`);
    }
    process.exit(0);
  }

  let ran = 0;
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const previous = applied.get(file);
    if (previous) {
      if (previous.checksum !== checksum) {
        console.warn(`! ${file} changed after it was applied. Create a new migration instead of editing history.`);
      }
      continue;
    }
    process.stdout.write(`applying ${file} ... `);
    try {
      await client.query(sql);
      await client.query(
        "insert into schema_migrations (id, checksum) values ($1, $2) on conflict (id) do update set checksum = excluded.checksum",
        [file, checksum],
      );
      console.log("ok");
      ran += 1;
    } catch (error) {
      console.log("failed");
      throw error;
    }
  }
  console.log(ran === 0 ? "Database is up to date." : `Applied ${ran} migration(s).`);
} finally {
  await client.end();
}
