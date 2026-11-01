# Neon Postgres setup

PDF Pro needs a PostgreSQL 14+ database. This deployment uses **Neon** (serverless Postgres)
because its free plan covers the whole schema comfortably: the app stores accounts,
subscriptions, payments and *file metadata* only — PDF bytes live in Cloudflare R2
(see [`STORAGE_SETUP.md`](STORAGE_SETUP.md)), so a file row costs about 1 KB.

> **Free plan, as of this writing:** 1 GB of Postgres per project, 100 CU-hours of compute per
> month, 5 GB of object storage (unused here), auto-suspend when idle (a few hundred ms wake-up
> on the next query), and project branching. It is not unlimited: if the CU-hours or storage are
> exhausted, compute is suspended until the next month. Check the current numbers on
> <https://neon.com/pricing> before launch.

## 1. Create the project

1. Sign in at <https://console.neon.tech> and **Create project**.
2. Pick the region closest to your Vercel deployment (e.g. `aws-ap-southeast-1` for users in
   Pakistan/Asia, `aws-us-east-2` if your other services live there). Region cannot be changed
   later without a new project.
3. Neon creates a database called `neondb` and a role named after the project. Either use those
   or create a dedicated database/role:

   ```sql
   create role pdfpro_app login password '<strong-password>';
   create database pdfpro owner pdfpro_app;
   ```

4. Copy the **pooled** connection string (Connection details → *Pooled connection*, host ends in
   `-pooler`) — that is what a serverless host needs, because each request can be a new process.

## 2. Configure the environment

```bash
DATABASE_URL=postgresql://pdfpro_app:<password>@ep-xxxx-pooler.us-east-2.aws.neon.tech/pdfpro?sslmode=require
PG_POOL_MAX=6                 # Neon free plan has tight connection limits; keep the pool small
```

`.env.local.example` contains exactly this block with dummy values. Never commit the real
`.env.local` (it is git-ignored).

## 3. Apply the schema

```bash
npm run db:migrate            # applies drizzle/*.sql in order, records checksums
npm run db:status             # shows applied vs pending
```

The migrations create `profiles`, `sessions`, `subscriptions`, `subscription_plans`,
`storage_usage`, `user_files`, `payments`, `admin_roles`, `settings`, `payment_webhook_events`,
`email_outbox`, `rate_limits` and the RLS policies. They are idempotent (`create table if not
exists`); re-running is safe, and `db:migrate` warns instead of silently re-applying a file whose
checksum changed.

`drizzle/0002_free_tier_storage_quotas.sql` shrinks the storage quotas to the free-tier sizing
(Free 200 MiB, Premium 2 GiB) and lowers the default upload cap to 50 MiB — only for rows that
still hold the original defaults, so customised plans survive.

## 4. Verify

```bash
psql "$DATABASE_URL" -c "select id, interval, price_minor, storage_bytes from subscription_plans order by sort_order"
psql "$DATABASE_URL" -c "select count(*) from information_schema.tables where table_schema = 'public'"
```

Expected: two plans (`premium_monthly` 150000 PKR, `premium_yearly` 1500000 PKR, both
`storage_bytes = 2147483648`) and 14+ tables. Then start the app and check `GET /api/health`.

## 5. Branching and development

- **Development branch:** Neon → Branches → *Create branch* from `main`. Point local
  `.env.local` at the branch's connection string; run `npm run db:migrate` against it. Delete or
  reset the branch freely — production data is untouched.
- **No database locally?** `npm run db:dev` still runs an embedded PostgreSQL (PGlite) on
  `127.0.0.1:5432` for tests and day-to-day work.
- **Backups:** Neon keeps a restore window on the free plan (hours, not days — check your
  project). For anything real, schedule `pg_dump` to R2 and keep the bucket backup in step with
  it, because file bytes and file rows must be restored together.

## 6. Operational notes

| Concern | Setting |
|---|---|
| Autosuspend wake-up | First request after idle may take ~0.5–1 s; the app retries nothing, so warm it with the cron job |
| Connection limits | Use the pooled host and keep `PG_POOL_MAX` ≤ 6 per instance |
| CU-hours | 100/month is plenty for a small site; a busy site exhausts it — watch the console banner |
| Storage | 1 GB per project; `user_files` rows are ~1 KB, `payments`/webhook rows a few KB each — thousands of accounts fit |
| SSL | Always `sslmode=require` (Neon rejects plaintext from outside its private network) |

## 7. What still needs a human

- Creating the Neon project and copying the real connection string (`DATABASE_URL`).
- Running `npm run db:migrate` against the production branch (or letting the deploy job do it).
- Setting `DATABASE_URL` / `PG_POOL_MAX` in the host's environment (e.g. Vercel → Settings →
  Environment Variables), never in a committed file.
