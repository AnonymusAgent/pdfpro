# Testing report — accounts, cloud storage, subscriptions

Status of the SaaS layer as built in this branch. Everything below was executed; nothing is
claimed without a run. Commands are reproducible from a clean checkout.

## 1. What was run, and the result

| Check             | Command                                                                                                     | Result                                                                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type check        | `npx tsc --noEmit`                                                                                          | **clean**                                                                                                                                                                                                                          |
| Lint (new code)   | `npx eslint src/components/{auth,ads,billing,cloud,account,admin} src/lib/server src/app/api tests scripts` | **0 errors, 0 warnings**                                                                                                                                                                                                           |
| Lint (whole repo) | `npx eslint .`                                                                                              | 0 errors in this work; 13 pre-existing errors remain in `EditorWorkspace.tsx`, `PageView.tsx`, `OcrWorkspace.tsx` (refs read during render / setState in effect) — untouched legacy editor code                                    |
| Production build  | `npm run build`                                                                                             | **success**, 41 routes compiled (all SaaS routes dynamic `ƒ`)                                                                                                                                                                      |
| Unit tests        | `npm run test:unit`                                                                                         | **89 passed / 89** in 11 files                                                                                                                                                                                                     |
| Integration tests | `npm run build && npm run test:integration`                                                                 | **44 passed / 44** in 4 files, ~7 s                                                                                                                                                                                                |
| Browser e2e       | `npm run test:e2e`                                                                                          | **not executed here**: `npx playwright install chromium` fails in this sandbox (download blocked, no system Chrome). The 21 specs collect successfully (`npx playwright test --list`) and run in CI/local with browsers installed. |

### Free-tier quota profile (verified on 2026-11-02)

The quotas were re-sized for the free tiers this deployment runs on (Cloudflare R2 = 10 GB of
objects, Neon = 1 GB of Postgres per project). Verification performed on a freshly migrated
database:

| Check | Command | Result |
| --- | --- | --- |
| Migration applies cleanly | `npm run db:migrate` | `0001` then `0002_free_tier_storage_quotas.sql` applied, `Applied 2 migration(s).` |
| Plan rows re-sized | `select storage_bytes from subscription_plans` | both plans `2147483648` (2 GiB), descriptions rewritten to "2 GB cloud storage" |
| Upload cap seeded | `select value from settings where key = 'storage'` | `{"maxUploadBytes": 52428800}` (50 MiB) |
| Free entitlement | integration `auth` suite | `entitlements.quotaBytes === 209715200` (200 MiB) |
| Premium entitlement | integration `billing` suite | quota becomes the plan row's `2147483648` after a signed webhook |
| Downgrade keeps files | integration `billing` suite | quota drops to 200 MiB, file count unchanged, uploads blocked |

The migration only rewrites rows that still carry the old seeded defaults, so plan prices,
quotas and descriptions an administrator has already edited are preserved.

## 2. Unit tests (`tests/unit`)

| File                      | Covers                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plans.test.ts`           | default 200 MB / 2 GB quota constants (free-tier sizing) + label formatting, remaining/percent maths, over-quota blocking without deleting files, negative-usage guard, byte and money formatting                                                                                                                                                                                 |
| `security.test.ts`        | scrypt hash/verify, per-hash salt, malformed hash rejection, HMAC-SHA256/512, constant-time compare, token hashing, email/password policy, text sanitising, file-name traversal (`../../etc/passwd` → `passwd.pdf`)                                                                                                          |
| `payments.test.ts`        | Safepay webhook HMAC-SHA512 accept/reject (tampering, wrong secret, missing header), redirect signature (HMAC-SHA256 over tracker), month/year period arithmetic, the exact Premium access rule for `active`/`pending`/`expired`/`past_due`+grace/`cancelled`, signed download tokens (foreign file, forged payload, expiry) |
| plus 7 pre-existing files | geometry, layout, export, operations, conversions, validation, OCR helpers — 53 tests; fixtures are now generated by `npm run fixtures`                                                                                                                                                                                      |

## 3. Integration tests (`tests/integration`, real HTTP against `next start`)

The harness starts the production build on `127.0.0.1:3300` with a console mail transport and
dev links enabled, then drives it with a cookie-aware HTTP client and a `pg` connection for
setup/verification.

### Authentication and sessions (14 tests)

- Weak password → `400 weak_password`; malformed email → `400 invalid_email`; duplicate registration → `409 email_taken`.
- Protected pages (`/dashboard`, `/cloud`, `/account`, `/admin`) redirect to `/login?next=…` without a session.
- Unverified accounts are blocked from uploads (`403 email_unverified`) and checkout (`403`).
- Verification token is single-use: replaying it for a verified account reports `alreadyVerified` and changes nothing; an unknown token is `400 invalid_token`.
- New account starts Free with `quotaBytes = 2,000,000,000`, `usedBytes = 0`.
- Wrong password → `401 invalid_credentials`; correct password sets `pdfpro_session`; logout invalidates it (subsequent `/api/files` → `401`).
- Two devices sign in independently; revoking one leaves the other working; "sign out other devices" semantics verified.
- Password change with the current password revokes other devices, keeps this one, and the old password no longer signs in.
- Password reset: single-use link, replay rejected, all sessions revoked, old password dead, new password works.
- Forgot-password never reveals whether an address exists.
- CSRF: mutation without `Origin` → `403`; mutation with `Origin: https://evil.example` → `403`.
- Google sign-in redirects to `/login?error=google_unavailable` when not configured.

### Cloud storage and quotas (7 tests)

- Upload → list → search → signed URL → download → rename → delete on a real PDF; byte counts and `%PDF-` magic verified on the wire.
- Cross-account isolation: another user cannot read, list, rename, delete or mint a URL for the file (`404` each), and a forged token is `403`; the owner is unaffected.
- Non-PDF and mislabelled payloads rejected with `415` before any row exists.
- Quota enforcement: with usage set 1 KB below the limit, upload → `413 quota_exceeded`; nothing written; after clearing usage the upload succeeds.
- Downgrade simulation: over-quota account keeps its file, shows `overQuota`/`uploadsBlocked`, cannot upload, can still download and delete.
- Delete reclaims exactly the file's bytes and count; a second delete is `404` and does not decrement again.
- Every storage route requires a session (`401`), including downloads without a token.

### Billing and lifecycle (14 tests)

- Plan catalogue comes from the database (`150000` / `1500000` PKR minor units, 2 GB Premium quota after `drizzle/0002`, monthly + yearly).
- Unknown plan → `404` before any provider call.
- **Signed webhook activates Premium**: subscription `active` with a future period end, payment `succeeded` with `paid_at`, quota becomes the plan's 2 GB, webhook row stored with `signature_valid = true`.
- **Idempotency**: replaying the same event → `200 duplicate`, period end unchanged; a new event id for an already-paid tracker also returns `duplicate` and does not extend the term.
- **Invalid signatures**: unsigned and forged-signature deliveries → `401`, nothing activated, payment stays `pending`; a later correctly signed event still activates.
- **Amount mismatch**: verified but wrong amount → `200 amount_mismatch`, payment `failed`, no Premium.
- **Grace period**: failed renewal → `past_due` with Premium retained; backdating `grace_until` + maintenance → Free quota (200 MB), files still listed and downloadable.
- **Expiry**: backdating `current_period_end` + maintenance → Free quota (200 MB), file count unchanged.
- **Cancellation**: cancel-at-period-end keeps Premium, then expiry returns Free; a second cancel is `404`.
- **Refund**: verified refund marks the payment `refunded` and ends Premium.
- **Return URL never activates**: unsigned return → not `paid`; bad signature → `failed`; another user's payment id → `unknown` (ownership-scoped); plan stays Free.
- Second checkout while Premium is active → `409 already_subscribed`.
- Payment history is visible to the owner in `/api/account`.
- Maintenance endpoint requires the cron secret or an administrator.

### Administration (9 tests)

- All admin routes return `401` anonymously and `403` for a normal user.
- Granting the `admin_roles` row enables `/api/admin/stats`; revoking it disables access again.
- A user cannot grant themselves admin (the `admin_roles` table stays empty).
- Price edit propagates to `/api/billing/plans` immediately; negative prices rejected.
- AdSense stays disabled without a publisher id; enabling with `ca-pub-…` + slots exposes them via `/api/site-config`; clearing the id disables it again.
- Pausing checkout makes `/api/billing/plans` report `available: false` and buyer checkout return `503 billing_paused`; invalid grace days rejected.
- Suspending a user revokes their sessions, blocks sign-in (`403 account_suspended`) and reactivating restores access.
- User search and aggregate metrics (users, subscriptions, payments, storage, webhooks) return coherent numbers.
- A signed-in non-admin sees "Administrator access required" on `/admin` instead of the dashboard.

## 4. Bugs found by these tests (fixed in this branch)

1. **Cross-account access on `/api/billing/verify-return`** — the endpoint looked a payment up by id without scoping to the caller, so a payment UUID from another account returned status information. Fixed: ownership is part of the query (`id = $1 and user_id = $2`), and the admin `force_verify` action resolves the owner explicitly. Regression test: _"never activates Premium from the return URL alone"_.
2. **Pool deadlock on upload** — `uploadPdfFile` called `getEntitlements()` (a second pooled connection) while holding `select … for update` on `storage_usage`. Under load the pool could exhaust and the request hung until the connection timeout, then returned 500. Fixed: `getEntitlements(userId, executor, maxUploadBytes)` accepts the transaction handle, so the whole critical section uses one connection; also added `PG_POOL_MAX`, idle and connect timeouts.
3. **Duplicate registration returned 500** — Drizzle wraps driver errors, so the SQLSTATE `23505` lived on `error.cause`. Fixed: `isUniqueViolation` walks the cause chain. Now `409 email_taken`.
4. **Provider outage turned the return page into a 500** — `verifyCheckoutReturn` propagated a network error. Fixed: returns `status: "pending"` with an honest message and never activates anything.
5. **Seeded prices were 100× too low** — `1500`/`15000` minor units rendered as Rs 15 / Rs 150. Corrected to `150000` / `1500000` (Rs 1,500 / Rs 15,000) in the migration.
6. **Verification links were reusable** — the handler verified unverified accounts again with a consumed token. Fixed: a consumed token now errors (`token_used`) unless the account is already verified, in which case it is reported idempotently.
7. **Missing test fixtures** — 53 pre-existing unit tests failed on missing `tests/fixtures/*`. Added `npm run fixtures`, which generates a PDF, a scan-like PNG and a baseline JPEG deterministically.

## 5. Browser e2e (`tests/e2e/saas.spec.ts`, 12 new specs)

Written and collected but **not executed in this sandbox** (no Chromium available). They cover:
redirect-to-login for protected pages, register → verify → dashboard, sign-in/sign-out,
password reset via the UI, pricing comparison, dashboard cards, upload → rename → download →
delete in the cloud manager, search persisting across reload, profile update and device list,
billing tab, the non-admin `/admin` notice, and "no AdSense markup when unconfigured".

Run them with:

```bash
npm run build
npx playwright install chromium
npm run test:e2e
```

## 6. Required scenarios — traceability

| #   | Requirement                                       | Evidence                                                                                                                                |
| --- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Free user can register and verify                 | auth suite: register/verify, `EMAIL_EXPOSE_DEV_LINKS` link                                                                              |
| 2   | Free user cannot exceed the Free quota             | storage: "enforces the storage quota server-side" (200 MB by default)                                                                   |
| 3   | Premium quota is larger than Free                 | billing: quota becomes the plan's `2,147,483,648` bytes after activation                                                                |
| 4   | Files are private between users                   | storage: "keeps every account's files private"                                                                                          |
| 5   | Downloads use signed, expiring URLs               | unit token tests + storage signed-URL/inline/expiry cases                                                                               |
| 6   | Delete reclaims quota                             | storage: "reclaims quota when files are deleted"                                                                                        |
| 7   | Downgrade never deletes files                     | storage: "keeps files when a downgrade puts the account over quota"; billing: expiry keeps files                                        |
| 8   | Only verified payments grant Premium              | billing: signed activation, unsigned rejection, amount mismatch                                                                         |
| 9   | Webhooks are idempotent                           | billing: "is idempotent for repeated deliveries of the same event"                                                                      |
| 10  | Failed payment enters grace, then Free            | billing: grace-period test                                                                                                              |
| 11  | Cancellation keeps access until period end        | billing: cancel-at-period-end test                                                                                                      |
| 12  | Refund ends Premium                               | billing: refund test                                                                                                                    |
| 13  | Prices are admin-editable without code changes    | admin: price edit → public `/api/billing/plans`                                                                                         |
| 14  | Admin routes are RBAC-protected                   | admin: 401/403 matrix, grant/revoke, self-grant refusal                                                                                 |
| 15  | Suspension blocks access immediately              | admin: suspend test                                                                                                                     |
| 16  | Ads never appear without approval or for Premium  | admin AdSense test + unit/lifecycle rules + e2e "no AdSense markup"; Premium rule covered by `plan === "premium"` gate in `ad-slot.tsx` |
| 17  | CSRF protection on mutations                      | auth: missing/foreign `Origin` → 403                                                                                                    |
| 18  | Password reset is single-use and revokes sessions | auth: reset test                                                                                                                        |
| 19  | PDF tools keep working unchanged                  | pre-existing unit suites + e2e `app.spec.ts`; the SaaS changes are additive                                                             |
| 20  | Existing data and integrations are preserved      | migrations are additive; legacy `documents/signatures/settings/jobs` untouched; `/api/health`, `/api/documents`, `/api/jobs` unchanged  |

## 7. Known gaps and risks

- **Browser e2e not run here** (no Chromium). The specs are ready; run them before release.
- **Safepay live flow not exercised** — no merchant credentials in this environment. The webhook
  and return paths are covered with real HMAC signatures; the hosted checkout redirect needs a
  sandbox merchant account (`docs/SAFEPAY_SETUP.md`).
- **Google sign-in not exercised end-to-end** — requires OAuth credentials and a browser; the
  unconfigured path is tested.
- **S3 storage driver** (Neon Object Storage, Cloudflare R2, AWS S3, MinIO) is implemented and
  unit-tested for configuration resolution, credential validation and command mapping (with a
  stubbed client), but no request has been made against a real bucket from this environment.
  Verify the round trip against your own private bucket before switching `STORAGE_DRIVER=s3`
  (see `docs/STORAGE_SETUP.md` for the checklist).
- **`storage_usage` drift** is prevented by transactional updates, but a manual database edit
  (as the tests do) will desynchronise it from `user_files`; recount with
  `select sum(size_bytes) from user_files where status='active'` if ever in doubt.
- The development database (PGlite over the wire protocol) caps concurrent connections; set
  `PGLITE_MAX_CONNECTIONS` (default 40) and `PG_POOL_MAX` when running many clients locally.
