# PDF Pro — HTTP API

All endpoints are JSON, served by the Next.js route handlers in `src/app/api`. Document content is **never** sent to these endpoints: documents are processed in the browser. The API stores metadata, settings, saved signature images you explicitly save, and a processing log.

Errors use one shape: `{ "error": "human-readable message" }` with an HTTP status code (400 validation, 404 not found, 413 too large, 500/503 server or database problems).

| Method | Path                  | Purpose                                                           |
| ------ | --------------------- | ----------------------------------------------------------------- |
| GET    | `/api/health`         | Liveness check. Returns `{ "ok": true }` when PostgreSQL answers. |
| GET    | `/api/documents`      | Recent document metadata (max 100, newest first).                 |
| POST   | `/api/documents`      | Record an opened document. Upserts by `name` + `size`.            |
| PATCH  | `/api/documents`      | Star/unstar or rename.                                            |
| DELETE | `/api/documents?id=`  | Remove a history entry (the file itself is never stored).         |
| GET    | `/api/settings`       | Shared preferences.                                               |
| PUT    | `/api/settings`       | Update preferences (whitelisted keys only).                       |
| GET    | `/api/signatures`     | Saved signature images (max 20).                                  |
| POST   | `/api/signatures`     | Save a PNG/JPEG signature data URL (≤ 700 KB).                    |
| DELETE | `/api/signatures?id=` | Delete a saved signature.                                         |
| GET    | `/api/jobs`           | Processing log (max 50, newest first).                            |
| POST   | `/api/jobs`           | Append a processing log entry.                                    |

The endpoints below were added with accounts, cloud storage and billing. Every mutation requires an `Origin` (or `Referer`) matching the request host, and every endpoint that touches tenant data requires a session. Errors use one shape — `{ "error": "…", "code": "machine_code" }` — with `400` validation, `401` unauthenticated, `403` forbidden/unverified, `404` not found, `409` conflict, `413` quota or size, `429` rate limited, `503` integration unavailable.

## Authentication

| Method | Path                            | Purpose                                                                                                                         |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/auth/register`            | Closed; always `403 registration_closed`. Accounts are added by signed-in administrators.                                                |
| POST   | `/api/auth/login`               | Email + password sign-in. Sets the session cookie.                                                                              |
| POST   | `/api/auth/logout`              | Revoke the current session and clear the cookie.                                                                                |
| GET    | `/api/auth/session`             | Current user, entitlements, notifications and integration flags. `no-store`.                                                    |
| POST   | `/api/auth/verify-email`        | `{ token }` — single use; replaying a link for an already-verified account returns `alreadyVerified: true` and changes nothing. |
| POST   | `/api/auth/resend-verification` | Send a fresh verification email (rate limited).                                                                                 |
| POST   | `/api/auth/forgot-password`     | Always `200`; sends a reset link when the address exists.                                                                       |
| POST   | `/api/auth/reset-password`      | `{ token, password }` — revokes every session.                                                                                  |
| POST   | `/api/auth/password`            | `{ currentPassword, newPassword }` — revokes the other devices, keeps this one.                                                 |
| GET    | `/api/auth/google/start`        | Redirect to Google (PKCE). `302` to `/login?error=google_unavailable` when unconfigured.                                        |
| GET    | `/api/auth/google/callback`     | Exchange the code, verify the ID token and sign in existing non-admin users only; cannot create new accounts or sign in as admin.                                                                     |

Administrator account creation: `POST /api/admin/users` with `{ email, password, displayName? }` requires an administrator session and same origin, is rate-limited, returns `201` with `id`, `email`, `emailDelivered`, `emailTransport` (and `previewUrl` only when development links are enabled). It never signs in as the new user. A `409 email_taken` leaves the existing user untouched. The admin UI is under Account settings → Profile → Add a user.

When Cloudflare Turnstile is configured (`TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`),
`login`, `forgot-password` and `reset-password` additionally require the widget's
single-use token in the JSON body as `turnstileToken`. Failures are

| Status | `code`                     | Meaning                                                           |
| ------ | -------------------------- | ----------------------------------------------------------------- |
| `400`  | `turnstile_required`       | token missing, blank or malformed                                 |
| `403`  | `turnstile_failed`         | Cloudflare rejected the token (expired, reused, invalid)          |
| `403`  | `turnstile_hostname_mismatch` | token was issued for a different hostname                      |
| `503`  | `turnstile_unavailable`    | `siteverify` unreachable / non-2xx / timed out; the request is refused |

With no keys the field is ignored and the routes behave as documented above. See
[`CLOUDFLARE_SETUP.md`](CLOUDFLARE_SETUP.md).

`GET /api/auth/session` returns:

```json
{
  "user": {
    "id": "uuid",
    "email": "you@example.com",
    "emailVerified": true,
    "plan": "free",
    "isAdmin": false
  },
  "entitlements": {
    "plan": "free",
    "quotaBytes": 209715200,
    "usedBytes": 0,
    "fileCount": 0,
    "maxUploadBytes": 52428800,
    "storage": {
      "usedBytes": 0,
      "quotaBytes": 209715200,
      "remainingBytes": 209715200,
      "percentUsed": 0,
      "fileCount": 0,
      "overQuota": false,
      "uploadsBlocked": false,
      "uploadsBlockedReason": null
    },
    "subscription": null,
    "premiumEndsAt": null,
    "inGracePeriod": false
  },
  "notifications": [],
  "features": {
    "googleSignIn": false,
    "cardCheckout": true,
    "checkoutUnavailableReason": null
  }
}
```

## Account

| Method | Path                    | Purpose                                                                               |
| ------ | ----------------------- | ------------------------------------------------------------------------------------- |
| GET    | `/api/account`          | Profile, subscriptions, payments, sessions and notifications.                         |
| PATCH  | `/api/account`          | Update `displayName`, `fullName`, `company`, `country`, `timezone`, `marketingOptIn`. |
| GET    | `/api/account/sessions` | Signed-in devices with `current` flag.                                                |
| POST   | `/api/account/sessions` | `{ sessionId }` to revoke one device, or `{ all: true }` to sign out everywhere else. |

## Cloud storage

| Method | Path                              | Purpose                                                                                                                                           |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/files?q=&sort=name          | size                                                                                                                                              | created&order=asc | desc&limit=&offset=` | List the caller's files plus the storage snapshot. |
| POST   | `/api/files`                      | `multipart/form-data` with a `file` field (PDF only, ≤ `STORAGE_MAX_UPLOAD_BYTES`) and optional `name`. `201` with the file and storage snapshot. |
| GET    | `/api/files/{id}`                 | Metadata for one owned file.                                                                                                                      |
| PATCH  | `/api/files/{id}`                 | `{ name }` — rename (spaces preserved, `.pdf` enforced).                                                                                          |
| DELETE | `/api/files/{id}`                 | Delete the object and reclaim quota.                                                                                                              |
| GET    | `/api/files/{id}/url`             | Short-lived signed download URL (`expiresInSeconds`).                                                                                             |
| GET    | `/api/files/{id}/download?token=` | Stream the file. Accepts an owner session **or** a signed token; `403` for a bad/expired token.                                                   |

Quota errors return `413` with `code: "quota_exceeded"` and `{ usedBytes, quotaBytes, remainingBytes }`. Non-PDF payloads return `415 unsupported_type`; oversized files return `413 file_too_large`. Ownership failures return `404`.

## Billing

| Method | Path                            | Purpose                                                                                                                                                                                                       |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/billing/plans`            | Public plan catalogue (prices read from the database), checkout availability and its reason.                                                                                                                  |
| POST   | `/api/billing/checkout`         | `{ planId }` → `{ redirectUrl, paymentId, tracker }`. Never activates Premium. `409 already_subscribed` when a live subscription exists; `503 billing_paused` / `provider_unconfigured` when checkout is off. |
| POST   | `/api/billing/verify-return`    | `{ paymentId, tracker, signature }` — verifies the return signature and re-checks the payment server-to-server. Returns `status: paid                                                                         | pending | failed | unknown`. Scoped to the caller's own payments. |
| POST   | `/api/billing/cancel`           | Cancel at period end (keeps Premium until the term ends). `404 no_subscription` when nothing is active.                                                                                                       |
| POST   | `/api/payments/safepay/webhook` | Provider webhook. HMAC-SHA512 signature required; `401` when invalid; `200 { received, duplicate, outcome }` otherwise.                                                                                       |

`GET /api/billing/plans` example:

```json
{
  "ok": true,
  "plans": [
    {
      "id": "premium_monthly",
      "name": "Premium Monthly",
      "interval": "month",
      "priceMinor": 150000,
      "currency": "PKR",
      "compareAtMinor": null,
      "billingMode": "one_time",
      "storageBytes": 10000000000,
      "active": true
    },
    {
      "id": "premium_yearly",
      "name": "Premium Yearly",
      "interval": "year",
      "priceMinor": 1500000,
      "currency": "PKR",
      "compareAtMinor": 1800000,
      "billingMode": "one_time",
      "storageBytes": 10000000000,
      "active": true
    }
  ],
  "currency": "PKR",
  "checkout": { "available": true, "reason": null, "provider": "safepay" },
  "billing": { "graceDays": 3, "supportEmail": "billing@example.com" }
}
```

Prices are always in the currency's minor unit (paisa/cents).

## Public configuration

| Method | Path               | Purpose                                                                                                                                    |
| ------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/site-config` | Plans, ad settings and integration flags for the browser. Contains no secrets: the AdSense publisher id and slot ids are public by design. |

```json
{ "ok": true, "plans": [ … ],
  "ads": { "enabled": false, "publisherId": "", "slots": {}, "requireConsent": true },
  "checkout": { "available": true, "reason": null, "provider": "safepay" } }
```

## Administration

Every route below calls `requireAdmin()`; anonymous callers get `401`, non-admins `403`. All mutations are written to `audit_log`.

| Method | Path                                 | Purpose                                                                                                                                                                                           |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/admin/stats`                   | Users (total/free/premium/verified/new), subscriptions (active/past due), revenue per currency (MRR, annual-plan revenue, 30-day and lifetime), payment counts, storage totals, webhook counters. |
| GET    | `/api/admin/users?q=&limit=&offset=` | Search users by email or display name.                                                                                                                                                            |
| PATCH  | `/api/admin/users`                   | `{ userId, action: grant_admin                                                                                                                                                                    | cancel_admin | revoke_admin | suspend | activate, value? }`. |
| GET    | `/api/admin/subscriptions`           | Subscriptions with plan and user context.                                                                                                                                                         |
| POST   | `/api/admin/subscriptions`           | `{ action: "sync" }` runs the lifecycle job; `{ action: "cancel_now", userId }`; `{ action: "force_verify", paymentId }` re-checks a payment with the provider.                                   |
| GET    | `/api/admin/payments?status=&limit=` | Payment history for all users.                                                                                                                                                                    |
| PATCH  | `/api/admin/plans`                   | `{ id, name?, priceMinor?, compareAtMinor?, currency?, providerPlanId?, billingMode?, active?, sortOrder? }`.                                                                                     |
| PATCH  | `/api/admin/settings`                | `{ billing?: { graceDays, paused, supportEmail }, adsense?: { enabled, publisherId, slots, requireConsent }, storage?: { maxUploadBytes } }`.                                                     |
| GET    | `/api/admin/outbox?limit=`           | Transactional email log (delivered/failed, with bodies).                                                                                                                                          |
| GET    | `/api/admin/webhooks?limit=`         | Webhook deliveries with signature validity and processing status.                                                                                                                                 |

## Maintenance

| Method | Path                    | Purpose                                                                                                                                           |
| ------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/cron/maintenance` | Expire subscriptions, finish pending deletions, prune rate limiters. Requires `Authorization: Bearer $CRON_SECRET` (or an administrator session). |
| GET    | `/api/cron/maintenance` | Returns a hint; safe to poke with an uptime monitor.                                                                                              |

Run the maintenance job every 15 minutes. It is what moves a lapsed subscription to `expired` and restores the Free-plan quota — files are never touched by it.

## Documents

`POST /api/documents`

```json
{ "name": "report.pdf", "size": 1048576, "pages": 12, "kind": "pdf" }
```

Rules: `name` 1–255 characters; `size` integer 0–2³¹−1; `pages` integer 0–100000; `kind` one of `pdf, docx, xlsx, pptx, image, txt`. Returns `201` with `{ "document": {...} }`.

`PATCH /api/documents` — `{ "id": 3, "starred": true }` or `{ "id": 3, "name": "New name" }`. Returns `404` for an unknown id.

## Settings

`PUT /api/settings` accepts only these keys:

| Key           | Type / range                                              |
| ------------- | --------------------------------------------------------- |
| `theme`       | `"light"` or `"dark"`                                     |
| `defaultZoom` | number, 25–400                                            |
| `defaultView` | `"continuous"`, `"single"`, or `"two-page"`               |
| `maxFileMB`   | number, 1–500                                             |
| `autosave`    | boolean                                                   |
| `ocrLang`     | three-letter codes joined by `+`, e.g. `eng` or `eng+spa` |

Unknown keys → `400` listing them. Invalid values → `400` listing the keys.

## Signatures

`POST /api/signatures`

```json
{
  "name": "My signature",
  "kind": "draw",
  "dataUrl": "data:image/png;base64,..."
}
```

`dataUrl` must be a PNG or JPEG data URL and at most 700,000 characters (`413` otherwise). `kind` is `draw`, `type`, or `upload`.

## Processing log

`POST /api/jobs`

```json
{
  "kind": "export-pdf",
  "fileName": "report.pdf",
  "inputSize": 1000,
  "outputSize": 1200,
  "status": "completed",
  "message": "Annotations embedded"
}
```

`kind` matches `^[a-z0-9-]{2,40}$`; `status` is `completed`, `failed`, or `cancelled`; `fileName` is reduced to its base name; `message` is truncated to 300 characters. Log messages must not contain document text.

## Chrome extension hand-off protocol

The extension exposes this to the PDF Pro web app through `chrome.runtime.sendMessage` (only origins listed in `externally_connectable` can reach it):

| Request                                             | Response                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `{ "type": "PDFPRO_PING" }`                         | `{ "ok": true, "version": "1.1.0" }`                                                                                                       |
| `{ "type": "PDFPRO_TAKE_HANDOFF", "id": "<uuid>" }` | `{ "ok": true, "name": "file.pdf", "base64": "..." }` — one-time: the stored copy is deleted when read. Hand-offs expire after 15 minutes. |

The service worker re-checks the sender origin against the configured PDF Pro origin and the localhost origins before answering.
