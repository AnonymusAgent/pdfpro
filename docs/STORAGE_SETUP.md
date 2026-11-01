# Object storage setup

The cloud file manager needs a place to put PDFs. Two drivers ship with the app:

| Driver | `STORAGE_DRIVER` | Use it when |
|---|---|---|
| Private directory on the server | `local` (default) | Single server, a mounted volume, or local development |
| S3-compatible bucket | `s3` | Serverless/multi-instance hosting, or you already pay for object storage |

`local` cannot be used on a serverless platform (Vercel, Netlify, Lambda): the filesystem is
ephemeral, so uploads disappear between requests. Use the `s3` driver there.

## Cloudflare R2 (recommended for this deployment)

This project targets **Neon Postgres + Cloudflare R2**. R2 is the cheapest way to keep PDFs
private on a shoestring budget: 10 GB of storage and **zero egress fees** on the free plan, and
`$0.015/GB-month` if you outgrow it. There is no such thing as unlimited free storage — the
quota is 10 GB, so the plan limits below are intentionally small.

> **Free-tier sizing.** R2 free = **10 GB total**, Neon free = **1 GB of Postgres per project**.
> The shipped quotas are Free **200 MiB** and Premium **2 GiB**, which means roughly 50 Free
> accounts or 5 Premium accounts fill the bucket. Raise them (Admin → Pricing → storage bytes,
> or `FREE_PLAN_STORAGE_BYTES` / `PREMIUM_PLAN_STORAGE_BYTES`) once you are on a paid plan.
> The database only stores metadata — a file row is ~1 KB — so thousands of accounts still fit
> inside Neon's 1 GB.

### 0. What is still needed from a human

| Item | Status |
|---|---|
| Cloudflare account with R2 enabled (R2 requires a card on file, even on the free plan) | **Outstanding — supplied by the site owner** |
| R2 bucket name (suggested `pdfpro-files`, private) | **Outstanding** |
| R2 API token Access Key ID + Secret Access Key | **Outstanding** |
| Cloudflare account id (for the endpoint host) | **Outstanding** |

Until those exist the app runs with `STORAGE_DRIVER=local`, or with `s3` and uploads disabled —
it never pretends an upload succeeded.

### 1. Create the bucket

Cloudflare dashboard → **R2** → **Create bucket** → name it `pdfpro-files`, leave **Public
access disabled** (the app only ever reads through signed server-side requests, so the bucket
needs no public URL and **no CORS configuration**).

### 2. Create an API token

R2 → **Manage R2 API Tokens** → **Create API token** → permission **Object Read & Write**,
scoped to that bucket. Copy the *Access Key ID* and *Secret Access Key* (the secret is shown
once). You also need the account id from the R2 overview page.

### 3. Configure the environment

```bash
STORAGE_DRIVER=s3
S3_BUCKET=pdfpro-files
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto                    # R2 always uses "auto"
S3_FORCE_PATH_STYLE=false         # R2 requires virtual-hosted style
S3_ACCESS_KEY_ID=<access key id>
S3_SECRET_ACCESS_KEY=<secret access key>
```

Everything else is unchanged: keys are `users/<userId>/<fileId>.pdf`, quota is enforced before
the object is written, and downloads still go through `/api/files/{id}/download?token=…`
(5-minute HMAC signature) or the owner's session. `.env.local.example` contains the same block
with placeholder values — copy it and fill in the real keys.

### 4. Verify

1. `GET /api/health` returns `{ ok: true }`.
2. Sign in, upload a small PDF at `/cloud`.
3. The object appears at `users/<userId>/<fileId>.pdf` in the R2 bucket browser.
4. Delete it in the UI and confirm the object disappears.
5. Open the object URL in a private window — it must **not** be reachable anonymously.

### 5. Cost guard-rails

- Free-plan quota is enforced server-side, so a runaway account cannot silently burn the
  allowance; R2 also supports a **notification/billing alert** — set one at 8 GB.
- Cloudflare does not charge for egress, so downloads, previews and signed URLs add nothing to
  the bill; Class A (writes) is 1M/month free, Class B (reads) 10M/month free.
- If a user downgrades, files are preserved; uploads are blocked until usage is back under the
  Free quota (see below).

## Neon Object Storage (single-vendor alternative)

Neon now ships **Object Storage**: S3-compatible buckets that live next to your Neon Postgres
project, branch with it, and are reachable with the plain S3 API (AWS SDK, `boto3`, `aws cli`,
presigned URLs). That means you do **not** need Supabase or another provider just to store
PDFs — the database and the files can come from the same account.

> Availability, as of this writing: the Neon backend (Postgres, Object Storage, Functions,
> Auth, AI Gateway) went generally available in September 2026. Object Storage is enabled per
> project and region, and the Free plan includes a small amount of storage per project (5 GB at
> the time of writing). Confirm the quota and region on your own project before launch —
> the shipped 200 MiB / 2 GiB plan quotas fit inside it comfortably.

### 1. Create the bucket

Either in the Neon Console (project → **Storage** → **Create bucket**, keep access
**private**), or declaratively:

```ts
// neon.ts
import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  buckets: {
    "pdfpro-files": {}, // private by default
  },
});
```

```bash
npx neon deploy    # provisions the bucket and writes the S3 variables to .env.local
```

`neon deploy` injects AWS-standard variables:

```
AWS_ACCESS_KEY_ID=…
AWS_SECRET_ACCESS_KEY=…
AWS_ENDPOINT_URL_S3=https://<region>.aws.neon.tech/storage
AWS_REGION=…
```

The application reads those automatically — no renaming needed.

### 2. Point the app at it

```bash
STORAGE_DRIVER=s3
S3_BUCKET=pdfpro-files
# optional: override anything the AWS_* variables supply
# S3_ENDPOINT=https://us-east-2.aws.neon.tech/storage
# S3_REGION=us-east-2
# S3_ACCESS_KEY_ID=…
# S3_SECRET_ACCESS_KEY=…
S3_FORCE_PATH_STYLE=true     # default; Neon requires path-style addressing
```

Restart the app. `GET /api/health` should still return `{ ok: true }`, and the first cloud
upload will create `users/<userId>/<fileId>.pdf` in the bucket.

### 3. Verify

1. Sign in, upload a small PDF at `/cloud`.
2. Check the object appears in the bucket (Console → Storage, or
   `aws s3 ls s3://pdfpro-files/users/ --endpoint-url $AWS_ENDPOINT_URL_S3`).
3. Delete it in the UI and confirm the object is gone.
4. Confirm the bucket is **private**: an anonymous `GET` of the object URL must fail. The app
   never links to bucket URLs — downloads go through `/api/files/{id}/download`, guarded by the
   owner's session or a 5-minute HMAC signature.

## Other S3 backends

The same driver works unchanged elsewhere; only the endpoint/region change.

| Provider | Endpoint | Notes |
|---|---|---|
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | region `auto`, `S3_FORCE_PATH_STYLE=false`, no egress fees — see the R2 section above |
| Amazon S3 | omit `S3_ENDPOINT` | set `S3_REGION`; path-style optional (`S3_FORCE_PATH_STYLE=false` is fine) |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | path-style on |
| MinIO | your server URL | path-style on |
| Supabase Storage | `https://<project>.supabase.co/storage/v1/s3` | S3 *protocol* only; the platform's own SDK is no longer used by this app |

## Guarantees the app relies on

- **Private buckets only.** There is no public URL code path; a bucket policy must not allow
  anonymous reads.
- **Server-side credentials.** Keys live in the server environment. Nothing is exposed to the
  browser (browsers receive only `/api/files/{id}/url` output).
- **Streaming uploads.** Files are streamed straight from the request body. When the declared
  size is known the driver issues a single `PutObject` with `ContentLength` (no buffering);
  otherwise it falls back to a multipart upload. A truncated body fails the upload with
  `upload_incomplete` and is deleted again — nothing is charged to the quota.
- **Ownership rechecked on every access.** Object keys include the user id, and every read,
  rename and delete re-queries `user_files` with `id` + `user_id`.
- **Quota is enforced before writing** and accounted for in the same transaction as the
  metadata insert; a failed insert deletes the object again.

## Migrating from the local driver

Existing rows point at keys of the form `users/<userId>/<fileId>.pdf`, which are identical in
both drivers — copy the directory contents into the bucket and switch `STORAGE_DRIVER`:

```bash
aws s3 sync .data/storage s3://pdfpro-files \
  --endpoint-url "$AWS_ENDPOINT_URL_S3" --region "$AWS_REGION"
```

Then verify a handful of downloads before removing the local copy.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `STORAGE_DRIVER=s3 but the object storage credentials are incomplete` | the listed variables are missing; `neon deploy` writes them to `.env.local`, not `.env` |
| `SignatureDoesNotMatch` | wrong secret, or `S3_FORCE_PATH_STYLE=false` against a path-style endpoint |
| `NoSuchBucket` | bucket name mismatch, or the bucket lives on another Neon branch |
| Uploads fail at exactly 50 MB | `STORAGE_MAX_UPLOAD_BYTES` (default 50 MiB) or your reverse proxy's body limit |
| `S3_FORCE_PATH_STYLE` errors against R2 | R2 needs `false`; Neon/MinIO need `true` |
| Downloads 404 but the object exists | the row was written by a different branch/bucket; objects and rows must come from the same Neon branch |
