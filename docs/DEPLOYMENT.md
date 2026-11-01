# Deployment

PDF Pro is a single Next.js 16 application (App Router, Node runtime) plus PostgreSQL and a
private object store. The PDF tools still run entirely in the browser; the server handles
accounts, storage metadata, files you upload to the cloud manager and billing.

## 1. Requirements

| Component      | Minimum                                     | Notes                                                     |
| -------------- | ------------------------------------------- | --------------------------------------------------------- |
| Node.js        | 22                                          | The app uses native `fetch`, `File` and streaming uploads |
| PostgreSQL     | 14+                                         | Supabase, RDS, Cloud SQL, Neon or self-hosted             |
| Object storage | local disk **or** a private Supabase bucket | `STORAGE_DRIVER=local                                     | supabase` |
| HTTPS          | required                                    | Secure cookies, OAuth redirects, checkout return URLs     |
| Scheduler      | every 15 min                                | Calls `POST /api/cron/maintenance`                        |

## 2. First deploy

```bash
git clone <repo> && cd pdfpro
npm ci
node scripts/setup-assets.mjs      # copies PDF.js/Tesseract assets into public/vendor
cp .env.example .env               # fill DATABASE_URL, APP_URL, AUTH_SECRET, STORAGE_SIGNING_SECRET
npm run db:migrate                 # applies drizzle/*.sql (idempotent, tracked in schema_migrations)
npm run db:status                  # shows applied migrations and checksum drift
npm run build
npm run start                      # or a process manager / container
```

The first verified sign-in for an address listed in `ADMIN_EMAILS` grants the administrator
role. Otherwise grant it explicitly:

```bash
npm run admin:grant -- you@example.com
npm run admin:grant -- support@example.com --role support
npm run admin:grant -- someone@example.com --remove
```

## 3. Environment

All variables are documented in `.env.example`. The only ones without which the app cannot
run are `DATABASE_URL` and `AUTH_SECRET`; each optional integration degrades explicitly (the UI
says what is unavailable and why) rather than failing at request time.

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # AUTH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # STORAGE_SIGNING_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # CRON_SECRET
```

Set `AUTH_EXPOSE_DEV_LINKS=false` in production — it returns verification/reset links in API
responses and exists only for local development and automated tests.

## 4. Storage

**Local disk** (`STORAGE_DRIVER=local`): files land in `STORAGE_DIR` (default `.data/storage`)
keyed `users/<userId>/<fileId>.pdf`. Mount a persistent volume, back it up with the database,
and keep it out of the container image. Uploads stream to disk; nothing is buffered in memory.

**Supabase Storage** (`STORAGE_DRIVER=supabase`): create a **private** bucket
(`SUPABASE_STORAGE_BUCKET`, default `pdfpro-files`), then set `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`. The service-role key stays server-side; browsers only ever see
signed URLs issued by `/api/files/{id}/url`.

Either way, a deployment **must not** expose the storage location directly. Downloads go
through `/api/files/{id}/download`, which re-checks ownership or validates an HMAC signature.

## 5. Database

- Migrations: `npm run db:migrate` (applies pending files, records checksums, warns on drift).
- Backups: standard PostgreSQL backups cover accounts, subscriptions, payments and file
  metadata. **File bytes live outside PostgreSQL** — back up the bucket/directory separately
  and keep the two backups in step.
- Row-level security policies are installed on the tenant tables for defence in depth. The
  owning database role bypasses RLS, so application-level checks remain the primary control.
- Scaling: each instance keeps a pool of `PG_POOL_MAX` (default 10) connections. Set
  `PG_POOL_MAX` for your plan and use a pooler (pgBouncer, Supabase pooler) in front of the
  database if you run many instances.

## 6. Scheduler

```bash
# crontab
*/15 * * * * curl -fsS -X POST https://<your-domain>/api/cron/maintenance \
  -H "Authorization: Bearer $CRON_SECRET" > /dev/null
```

This job expires lapsed subscriptions (restoring the Free quota **without deleting files**),
finishes pending deletions, prunes rate-limit rows and old webhook events. Without it, an
expired subscription keeps Premium until someone opens the account page (entitlements are also
checked at read time, so the user is never over-privileged — the job just keeps the stored
state tidy and sends notifications).

## 7. Reverse proxy

- Terminate TLS, forward `X-Forwarded-Proto`/`X-Forwarded-Host` (used to build absolute URLs).
- Allow uploads up to `STORAGE_MAX_UPLOAD_BYTES` (default 100 MiB) — set `client_max_body_size`.
- Suggested headers:

  ```
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://pagead2.googlesyndication.com; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; connect-src 'self' https://pagead2.googlesyndication.com; frame-src https://googleads.g.doubleclick.net https://tpc.googlesyndication.com; object-src 'none'; base-uri 'self'; form-action 'self'
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  ```

  Drop the AdSense hosts from the policy unless advertising is enabled.

## 8. Health and observability

- `GET /api/health` → `{ ok: true }` when PostgreSQL answers. Use it for liveness and for the
  load balancer.
- Admin → _Email & webhooks_ shows the email outbox and every webhook delivery with signature
  validity and processing outcome. This is the first place to look when a payment is stuck.
- Server logs are single-line JSON-ish summaries; they never contain document text, passwords
  or card data.

## 9. Upgrade procedure

```bash
git pull
npm ci
node scripts/setup-assets.mjs
npm run db:migrate     # additive migrations only
npm run build
# restart the app, then verify: /api/health, sign-in, an upload, a webhook replay
```

Migrations are additive: existing `documents`, `signatures`, `settings` and `jobs` tables and
their rows are untouched.

## 10. Rollback

- Application: redeploy the previous build; migrations add tables/columns and do not rewrite
  legacy data, so an older build keeps working.
- Data: restore the PostgreSQL dump **and** the storage backup together — file metadata
  without the objects (or the reverse) produces 404s on download.

## 11. Go-live checklist

- [ ] `AUTH_SECRET`, `STORAGE_SIGNING_SECRET`, `CRON_SECRET` are unique random values
- [ ] `AUTH_EXPOSE_DEV_LINKS=false`
- [ ] HTTPS enforced, `APP_URL` matches the public origin
- [ ] Database backed up, migrations applied, `npm run db:status` clean
- [ ] Storage bucket/directory private and included in backups
- [ ] Email transport configured and a test verification email received
- [ ] Safepay live keys + webhook registered (see `docs/SAFEPAY_SETUP.md`)
- [ ] AdSense credentials present **or** advertising left disabled (see `docs/ADSENSE_SETUP.md`)
- [ ] Cron scheduled; a manual run returns `{ ok: true }`
- [ ] Administrator account created and `ADMIN_EMAILS` reviewed
- [ ] `npm run test:unit`, `npm run test:integration` and `npm run test:e2e` pass
- [ ] Privacy policy, terms and refund/support contact published
