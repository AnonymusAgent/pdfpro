# Object storage setup

The cloud file manager needs a place to put PDFs. Two drivers ship with the app:

| Driver | `STORAGE_DRIVER` | Use it when |
|---|---|---|
| Private directory on the server | `local` (default) | Single server, a mounted volume, or local development |
| S3-compatible bucket | `s3` | Serverless/multi-instance hosting, or you already pay for object storage |

`local` cannot be used on a serverless platform (Vercel, Netlify, Lambda): the filesystem is
ephemeral, so uploads disappear between requests. Use the `s3` driver there.

## Neon Object Storage (recommended if you already use Neon)

Neon now ships **Object Storage**: S3-compatible buckets that live next to your Neon Postgres
project, branch with it, and are reachable with the plain S3 API (AWS SDK, `boto3`, `aws cli`,
presigned URLs). That means you do **not** need Supabase or another provider just to store
PDFs — the database and the files can come from the same account.

> Availability, as of this writing: the Neon backend (Postgres, Object Storage, Functions,
> Auth, AI Gateway) went generally available in September 2026. Object Storage is enabled per
> project and region, and the Free plan includes a small amount of storage per project (5 GB at
> the time of writing). Confirm the quota and region on your own project before launch —
> 2 GB per Free user and 10 GB per Premium user add up quickly.

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
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | region `auto`, path-style on, no egress fees |
| Amazon S3 | omit `S3_ENDPOINT` | set `S3_REGION`; path-style optional (`S3_FORCE_PATH_STYLE=false` is fine) |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | path-style on |
| MinIO | your server URL | path-style on |
| Supabase Storage | `https://<project>.supabase.co/storage/v1/s3` | S3 *protocol* only; the platform's own SDK is no longer used by this app |

## Guarantees the app relies on

- **Private buckets only.** There is no public URL code path; a bucket policy must not allow
  anonymous reads.
- **Server-side credentials.** Keys live in the server environment. Nothing is exposed to the
  browser (browsers receive only `/api/files/{id}/url` output).
- **Streaming uploads.** Files are streamed to the bucket in 8 MB parts (`@aws-sdk/lib-storage`),
  so a 100 MB PDF does not sit in memory.
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
| Uploads fail at exactly 100 MB | `STORAGE_MAX_UPLOAD_BYTES` or your reverse proxy's body limit |
| Downloads 404 but the object exists | the row was written by a different branch/bucket; objects and rows must come from the same Neon branch |
