#!/usr/bin/env node
/**
 * Grant or revoke the administrator role from the command line.
 *
 *   npm run admin:grant -- you@example.com
 *   npm run admin:grant -- you@example.com --remove
 *   npm run admin:grant -- you@example.com --role support
 *
 * The account must exist and have a verified email address. This is the
 * supported way to bootstrap the first administrator; ADMIN_EMAILS in the
 * environment also grants the role automatically on verification/login.
 */
import "dotenv/config";
import pg from "pg";

const args = process.argv.slice(2);
const email = (args.find((arg) => !arg.startsWith("--")) ?? "").trim().toLowerCase();
const remove = args.includes("--remove");
const roleIndex = args.indexOf("--role");
const role = roleIndex >= 0 ? (args[roleIndex + 1] === "support" ? "support" : "admin") : "admin";

if (!email) {
  console.error("Usage: npm run admin:grant -- you@example.com [--remove] [--role admin|support]");
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || process.env.DATABASE_URL_POOLED;
if (!connectionString) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();
try {
  const { rows } = await client.query(
    "select id, email, email_verified_at is not null as verified from users where email_normalized = $1",
    [email],
  );
  const user = rows[0];
  if (!user) {
    console.error(`No account found for ${email}. Register first, then run this again.`);
    process.exit(1);
  }
  if (!remove && !user.verified) {
    console.error(`${email} has not verified its email address yet. Verification is required before granting admin.`);
    process.exit(1);
  }
  if (remove) {
    await client.query("delete from admin_roles where user_id = $1", [user.id]);
    console.log(`Administrator access removed from ${email}.`);
  } else {
    await client.query(
      `insert into admin_roles (user_id, role) values ($1, $2)
       on conflict (user_id) do update set role = excluded.role`,
      [user.id, role],
    );
    console.log(`${email} now has the "${role}" role.`);
  }
} finally {
  await client.end();
}
