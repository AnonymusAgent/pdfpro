#!/usr/bin/env node
/**
 * One-time operator-only bootstrap. Never run in a web request or deploy hook.
 * Read the password from an ephemeral environment variable, not CLI arguments
 * (which can appear in process lists). Requires a migrated database.
 * Refuses to modify any existing account or password.
 */
import "dotenv/config";
import pg from "pg";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";

const email = (process.argv[2] ?? "").trim().toLowerCase();
const password = process.env.PDFPRO_BOOTSTRAP_PASSWORD;
const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || process.env.DATABASE_URL_POOLED;
if (!/^[^\s@]+@[^\s@.]+\.[^\s@.]+$/.test(email) || !password || !connectionString) {
  console.error("Usage: PDFPRO_BOOTSTRAP_PASSWORD=<secret> DATABASE_URL_UNPOOLED=<url> npm run admin:bootstrap -- admin@example.com (both variables must be set securely; never commit them)");
  process.exit(1);
}
if (password.length < 10 || password.length > 200 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password) || password.toLowerCase().includes(email.split("@")[0])) {
  console.error("Password must have 10–200 characters, a letter and a number, and not include the email username.");
  process.exit(1);
}

const salt = randomBytes(16);
const derived = await new Promise((resolve, reject) => {
  scryptCallback(password.normalize("NFKC"), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 16384 * 8 * 2 }, (error, key) => error ? reject(error) : resolve(key));
});
const passwordHash = `scrypt$16384$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query("begin");
  const { rows } = await client.query("select id from users where email_normalized = $1", [email]);
  if (rows.length) {
    throw new Error("That account already exists. No password or role was changed. Verify ownership and use admin:grant if appropriate.");
  }
  const inserted = await client.query(
    `insert into users (email, email_normalized, password_hash, email_verified_at, display_name)
     values ($1, $1, $2, now(), 'PDF Pro Admin') returning id`,
    [email, passwordHash],
  );
  const id = inserted.rows[0].id;
  await client.query("insert into profiles (user_id, full_name) values ($1, 'PDF Pro Admin')", [id]);
  await client.query("insert into storage_usage (user_id) values ($1)", [id]);
  await client.query("insert into admin_roles (user_id, role) values ($1, 'admin')", [id]);
  await client.query(
    "insert into audit_log (action, target_type, target_id, metadata) values ('admin.bootstrap', 'user', $1, $2::jsonb)",
    [id, JSON.stringify({ email })],
  );
  await client.query("commit");
  console.log(`Administrator account created for ${email}. Change its password after first sign-in.`);
} catch (error) {
  await client.query("rollback");
  console.error(error instanceof Error ? error.message : "Bootstrap failed.");
  process.exitCode = 1;
} finally {
  await client.end();
}
