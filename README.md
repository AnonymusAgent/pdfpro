# PDF Pro — Editor, Converter & OCR

PDF Pro is a browser-based PDF workspace (Next.js App Router + TypeScript + Tailwind) with a Manifest V3 Chrome extension. Documents are processed locally in the browser. The server stores only metadata, settings, saved signatures you choose to keep, and a processing log in PostgreSQL.

## Feature status

Legend: ✅ implemented and covered by an automated test · 🟡 implemented but approximate or partially limited · ❌ not implemented in this build.

| Area                                                                                                                      | Status | Notes                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| Open, view, search, zoom, rotate, continuous / single / two-page view                                                     | ✅     | PDF.js rendering, lazy pages, text layer selection, outline and attachments panels                 |
| Password-protected PDFs (open)                                                                                            | ✅     | Password prompt; incorrect password reported                                                       |
| Multiple open documents, isolated edit state, undo/redo                                                                   | ✅     | Each document has its own history                                                                  |
| Autosave and crash/refresh recovery                                                                                       | ✅     | IndexedDB; restore or discard on the Editor and Recent pages                                       |
| Annotations: highlight, underline, strike, draw, rectangle, ellipse, line, arrow, notes, stamps, text, links, form fields | ✅     | Export embeds them; rotation-aware placement tested                                                |
| Insert and move/resize/rotate images and signatures                                                                       | ✅     | PNG/JPEG; aspect ratio kept; rotation exported                                                     |
| Edit existing text                                                                                                        | 🟡     | Replacement overlay with a white cover. The original text remains unless secure export is used     |
| Page management: blank, duplicate, delete, reorder, rotate, extract, insert and replace from another PDF                  | ✅     | Replace keeps annotations on the page; review them                                                 |
| Crop, paper size (A4/A3/Letter/Legal), margins, background                                                                | ✅     | Crop applied as CropBox; resize embeds pages                                                       |
| Watermark, header/footer, page numbers, Bates numbers                                                                     | ✅     | Editor export and batch tools                                                                      |
| Secure redaction (rasterize + verify)                                                                                     | ✅     | Verified by text extraction before download                                                        |
| Visual-only redaction / whiteout                                                                                          | 🟡     | Covers only; text remains. Labelled as such                                                        |
| Merge, split (ranges, every page), extract                                                                                | ✅     | Verified outputs; ZIP for multi-file results                                                       |
| Compression: lossless, low/medium/high raster presets                                                                     | 🟡     | Raster presets turn text into images; never reported smaller unless smaller                        |
| Batch: rotate, watermark, page numbers, lossless, text                                                                    | ✅     | Per-file status and ZIP download                                                                   |
| OCR (Tesseract.js) with preprocessing, rotation detection, cancel                                                         | ✅     | English bundled; other languages downloaded from CDN once                                          |
| OCR review, low-confidence flagging, export TXT/MD/DOCX/XLSX/CSV, searchable PDF                                          | ✅     | Searchable PDF positions words from OCR boxes                                                      |
| PDF → DOCX (editable and layout)                                                                                          | ✅     | Parsed back with Mammoth in tests                                                                  |
| PDF → XLSX (per table / combined), CSV                                                                                    | 🟡     | Table detection is heuristic; numeric cells become numbers                                         |
| PDF → PPTX (editable and image)                                                                                           | ✅     | Same page size; complex layouts need adjustment                                                    |
| PDF → TXT, Markdown, HTML, RTF, ODT, EPUB, PNG, JPEG, TIFF, SVG                                                           | ✅     | Each output validated                                                                              |
| PDF → Searchable PDF                                                                                                      | ✅     | Via the OCR workspace                                                                              |
| PDF → PDF/A                                                                                                               | ❌     | Needs a validated engine (Ghostscript/veraPDF). Clearly labelled                                   |
| DOCX / XLSX / PPTX / TXT / MD / HTML / PNG / JPEG / TIFF → PDF; several → one PDF                                         | 🟡     | Text, tables, pictures and positions mapped; fonts approximated                                    |
| Legacy DOC / XLS / PPT                                                                                                    | ❌     | Needs LibreOffice (not configured). Rejected with an explanation                                   |
| Electronic (visual) signatures: draw, type, upload, save with consent                                                     | ✅     | Not certificate-based                                                                              |
| Certificate-based digital signatures                                                                                      | ❌     | Not in this build                                                                                  |
| Password protection (AES-256) and password removal with authorization                                                     | ✅     | Open password and permissions; verified                                                            |
| Metadata clean-up on export                                                                                               | ✅     | Rebuilt file carries no source document information                                                |
| Compare two PDFs (visual pixel diff + line-level text diff)                                                               | ✅     | Visual limited to 40 pages                                                                         |
| Form fields: create                                                                                                       | ✅     | Real AcroForm text fields                                                                          |
| Form fields: fill existing forms, import/export form data                                                                 | ❌     | Not implemented                                                                                    |
| Bookmarks in rebuilt exports                                                                                              | ❌     | Bookmarks are shown and used for navigation, but are not carried into exports that rebuild pages   |
| Optional-content layers (visibility toggles)                                                                              | ❌     | Not implemented                                                                                    |
| Chrome extension (MV3): context menus, popup, hand-off to editor                                                          | 🟡     | Packaging and manifest verified by tests; not yet exercised in a real Chrome profile (see Testing) |
| Accounts: email + password, verification, Google sign-in, reset, multi-device sessions                                    | ✅     | scrypt passwords, hashed opaque session tokens, per-device revocation                              |
| Personal cloud storage (upload, preview, rename, delete, search, sort)                                                    | ✅     | Free 200 MB / Premium 2 GB (free-tier sizing, admin-editable), private keys, signed URLs, server-side quota |
| Subscriptions: monthly + yearly Premium, admin-editable prices, lifecycle                                                 | ✅     | Safepay hosted checkout; Premium only on a verified payment; prices come from the database         |
| Admin dashboard: users, subscriptions, payments, pricing, settings, email/webhook logs                                    | ✅     | Server-side RBAC, role grants only from `ADMIN_EMAILS`/CLI, every action audited                   |
| Google AdSense for Free accounts                                                                                          | 🟡     | Implemented and gated; **disabled until approved publisher id and slot ids are supplied**          |

## SaaS layer at a glance

| Surface                                      | Route                                                                         | Who                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| Sign in / register / verify / reset          | `/login`, `/register`, `/verify-email`, `/forgot-password`, `/reset-password` | Everyone                                 |
| Dashboard                                    | `/dashboard`                                                                  | Signed in                                |
| Cloud file manager                           | `/cloud`                                                                      | Signed in + verified email               |
| Pricing                                      | `/pricing`                                                                    | Everyone (prices read from the database) |
| Account: profile, password, billing, devices | `/account?tab=profile                                                         | password                                 | billing | devices` | Signed in |
| Checkout return / abandon                    | `/billing/return`, `/billing/cancelled`                                       | Signed in                                |
| Administration                               | `/admin`                                                                      | `admin_roles` members only               |

Plan limits: Free = 209,715,200 bytes (200 MiB), Premium = 2,147,483,648 bytes (2 GiB). Both are sized for the free
tiers this app runs on (Cloudflare R2: 10 GB of objects, Neon: 1 GB of Postgres) and are configurable —
`FREE_PLAN_STORAGE_BYTES` / `PREMIUM_PLAN_STORAGE_BYTES` per deployment, or per plan in Admin → Pricing.
Downgrades never delete files: uploads are blocked while the account is over quota and every
existing file stays downloadable. There is no code path that grants Premium from a browser
response — activation happens only in `activatePaidPayment`, reached from a signed webhook or a
server-to-server lookup.

## Architecture

```
src/
  app/                       Next.js routes (App Router)
    page.tsx                 Home / dashboard
    editor/ convert/ ocr/ tools/ sign/ compare/ recent/ settings/ help/ extension/
    api/                     auth, account, files, billing, payments/webhook, admin, cron,
                             site-config, health (PostgreSQL via Drizzle)
    dashboard/ account/ cloud/ pricing/ admin/ billing/ login/ register/ …  SaaS pages
  components/
    shell.tsx                Header, navigation, theme, toasts, confirm dialogs
    ui.tsx                   Shared UI primitives (buttons, dialogs, dropzone, notices)
    auth/ ads/ billing/ cloud/ account/ admin/   SaaS client components
    editor/                  EditorWorkspace (tabs, toolbar, panels, export), PageView (render + overlay), EditorPanels
    convert/ ocr/ tools/ sign/ compare/ dashboard/ support/   Feature workspaces
  lib/
    store.tsx                Workspace state: documents, per-document history, autosave, staging
    browser.ts               Settings, downloads, printing, base64, IndexedDB sessions, API client, extension hand-off
    use-local.ts             localStorage subscriptions (useSyncExternalStore)
    pdf/
      types.ts               Shared document model (page entries, annotations, edit state)
      geometry.ts            Rotation mapping between page space and display space
      pdfjs.ts               PDF.js: open (password handling), render, thumbnails, text, search, outline
      export.ts              Export engine (pdf-lib): annotations, rotation, crop, paper size, redaction, encryption
      document-export.ts     Browser export orchestration: rasterized redaction and redaction verification
      layout.ts              Layout analysis: lines, headings, lists, tables
      extract.ts             Layout and page-render extraction for conversions
      convert-out.ts         PDF → DOCX / XLSX / PPTX / text / EPUB / ODT / SVG / TIFF
      convert-in.ts          DOCX / XLSX / PPTX / text / images → PDF
      ocr.ts                 OCR pipeline: preprocessing, Tesseract worker, word boxes, searchable PDF
      operations.ts          Merge, split, extract, rotate, decorate, encrypt, unlock, optimize, sample/blank PDFs
      compress.ts            Lossless and raster compression presets
      validate.ts            Output signature and parser validation
public/
  extension/                 Manifest V3 extension (manifest, service worker, popup, shared helpers, icons)
  vendor/                    Offline runtime assets copied by scripts/setup-assets.mjs
scripts/setup-assets.mjs     Copies PDF.js worker, Tesseract worker/core/English data; generates extension icons
scripts/dev-db.mjs           Embedded PostgreSQL (PGlite) for local development
scripts/migrate.mjs          Applies drizzle/*.sql, tracks checksums (--status to inspect)
scripts/grant-admin.mjs      Grant/revoke the administrator role from the CLI
scripts/make-test-fixtures.mjs  Regenerates the synthetic fixtures in tests/fixtures
src/db/                      Drizzle schema and client
src/lib/server/              Server-only: config, crypto, sessions, auth, entitlements, files,
                             storage drivers, payments (Safepay provider + billing lifecycle)
drizzle/                     SQL migrations (additive; legacy tables untouched)
tests/unit/                  Vitest: geometry, layout, export, operations, conversions, validation,
                             plans/quotas, crypto, Safepay signatures, lifecycle rules
tests/integration/           Vitest + HTTP against a running production build (auth, storage,
                             quota, webhooks, lifecycle, admin RBAC)
tests/e2e/                   Playwright: browser workflows against the production build
docs/                        API, security/privacy, Safepay, AdSense, deployment, test report
```

Processing services are plain TypeScript modules that do not depend on React, so the same code runs in the browser, in Web Workers (planned), and in Node tests. Expensive browser operations run on the main thread today; see Limitations.

## Setup

Prerequisites: Node.js 22 or newer, PostgreSQL 14+.

```bash
npm install
cp .env.local.example .env.local   # Neon + R2 template with placeholder values (.env.local is git-ignored)
# ...or start from .env.example and set DATABASE_URL, AUTH_SECRET, STORAGE_SIGNING_SECRET by hand
node scripts/setup-assets.mjs   # copies offline runtime assets into public/ and generates extension icons
npm run db:dev                  # optional: embedded PostgreSQL on 127.0.0.1:5432 (terminal 1)
npm run db:migrate              # creates/upgrades every table (terminal 2)
npm run dev                     # development server on http://localhost:3000
```

To read verification and password-reset links locally, set
`EMAIL_TRANSPORT=console` and `AUTH_EXPOSE_DEV_LINKS=true`. Links are then printed to the
server log and returned in the API response; the dashboard also shows the verification link
right after registration. Grant yourself the administrator role with
`npm run admin:grant -- you@example.com` (or list the address in `ADMIN_EMAILS`).

`npm run db:dev` runs a real PostgreSQL server (PGlite over the wire protocol) from
`node_modules` — no database install needed for development. Production must use PostgreSQL.

Production:

```bash
npm run build
npm run start                   # serves on http://localhost:3000
```

Re-run `node scripts/setup-assets.mjs` after upgrading `pdfjs-dist`, `tesseract.js`, `tesseract.js-core` or `@tesseract.js-data/eng`.

## Testing

```bash
npm run build                   # integration tests run against the production build
npm run test:unit               # Vitest: 89 unit tests
npm run test:integration        # Vitest + HTTP: 44 tests (needs a database and a free port 3300)
npx playwright install chromium # once; on Linux also: sudo npx playwright install-deps chromium
npm run test:e2e                # Playwright: 21 browser workflows against the production build
npm run test                    # unit + integration
npx tsc --noEmit                # type check
npx eslint .                    # lint (0 errors; a few intentional <img> warnings for data URLs)
```

The integration suite boots `next start` on port 3300 (or reuses a server already there) and
talks to it over HTTP with its own cookie jar. It covers registration/verification, login and
multi-device sessions, password reset, CSRF, storage isolation, quota enforcement, signed
URLs, webhook signature verification, idempotency, amount mismatches, refunds, grace periods,
expiry, admin RBAC and settings changes. Point `DATABASE_URL` at a disposable database: the
suite creates and removes `it+*@example.test` accounts.

Fixtures in `tests/fixtures` are synthetic and committed; regenerate them with `npm run fixtures`.

What the tests verify, with real files:

- Export: annotations embedded and re-read by PDF.js; annotations on rotated pages placed at the editor's coordinates; rotation, crop and A4 resizing; password protection that refuses to open without its password; visual-only redaction keeps text; **secure redaction removes the covered text and the output is verified**.
- Conversions: DOCX parsed by Mammoth (headings, tables); XLSX read by ExcelJS (numeric cells are numbers); PPTX parsed (one slide per page); EPUB/ODT/RTF/HTML/SVG/TIFF validated; CSV refuses pages without tables.
- Reverse conversions: Markdown, DOCX, XLSX and PPTX inputs produce PDFs whose text is extractable.
- Browser: home, 404, every route heading, sample → render → search, add text → export → re-open the download, PDF table → XLSX → unzip, OCR on an image (English data bundled), extension package manifest, theme persistence.

Not yet tested automatically: OCR accuracy against a scanned-document corpus; Office fidelity against a reference corpus; a real Chrome profile with the extension loaded (the extension logic is covered by the packaging test and by review, not by an installed-extension run).

## Chrome extension

1. Download the ZIP from the Extension page (or use `public/extension/`).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the folder.
3. Open the PDF Pro popup and set your PDF Pro address. The downloaded ZIP automatically lists the origin you downloaded it from in `externally_connectable.matches`; if you serve PDF Pro from another origin, download a fresh ZIP there and reload the extension.
4. Right-click a PDF link → **Open linked PDF in PDF Pro**, or open a PDF page → **Open this PDF in PDF Pro**.

Permissions (`manifest.json`): `contextMenus`, `storage`, `activeTab`, and optional host access (`http://*/*`, `https://*/*`) requested per site from the popup when you click **Allow access**. The extension does not read web pages, inject scripts, or access `chrome://` pages. PDFs up to 40 MB are handed to the editor through the extension's IndexedDB and a one-time identifier (see `docs/API.md`).

## Environment variables

Every variable is documented in [`.env.example`](.env.example), and
[`.env.local.example`](.env.local.example) is a ready-to-copy template pre-set for
Neon + Cloudflare R2 (dummy values only — never commit the filled-in `.env.local`). The short version:

| Variable                                         | Required           | Purpose                                                                  |
| ------------------------------------------------ | ------------------ | ------------------------------------------------------------------------ |
| `DATABASE_URL`                                   | yes                | PostgreSQL connection string used by Drizzle and the API routes          |
| `APP_URL`                                        | recommended        | Public origin used for email links, OAuth redirects and checkout returns |
| `AUTH_SECRET`                                    | yes                | Signs session cookies, email tokens and download links                   |
| `STORAGE_SIGNING_SECRET`                         | yes (cloud)        | Signs short-lived download URLs                                          |
| `EMAIL_TRANSPORT` + `SMTP_*` or `RESEND_API_KEY` | for real email     | `console` prints emails to the log and the outbox                        |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`      | for Google sign-in | OAuth with PKCE                                                          |
| `SAFEPAY_*`                                      | for payments       | Merchant keys, webhook secret, environment (see `docs/SAFEPAY_SETUP.md`) |
| `STORAGE_DRIVER=s3` + `S3_*` / `AWS_*`           | for cloud storage  | Private bucket — Cloudflare R2 recommended (see `docs/STORAGE_SETUP.md`) |
| `FREE_PLAN_STORAGE_BYTES` / `PREMIUM_PLAN_STORAGE_BYTES` | optional   | Quota defaults (200 MiB / 2 GiB); Admin → Pricing overrides per plan    |
| `ADSENSE_*`                                      | optional           | Advertising (see `docs/ADSENSE_SETUP.md`)                                |
| `ADMIN_EMAILS`                                   | optional           | Addresses that become administrators on first verified sign-in           |
| `CRON_SECRET`                                    | recommended        | Bearer secret for `/api/cron/maintenance`                                |

Only `NEXT_PUBLIC_*` variables can reach the browser bundle, and none of them carry secrets.
Object-storage credentials and payment secrets are read exclusively in server components and
route handlers.

## Deployment notes

- Serve over HTTPS. Browser features (IndexedDB, clipboard, Web Workers for WebAssembly) and Secure session cookies require a secure context outside localhost.
- Run `node scripts/setup-assets.mjs` as part of the build pipeline so PDF.js and Tesseract assets are present in `public/vendor`.
- The PDF tools make no server-side conversions and need no conversion workers. Object storage is only used by the cloud file manager.
- LibreOffice, Ghostscript or another engine is needed only for the features marked ❌ above; they are not wired into this build.
- Download the extension ZIP from the deployed origin so its `externally_connectable` list contains that origin.
- Schedule `POST /api/cron/maintenance` every 15 minutes with `Authorization: Bearer $CRON_SECRET`: it expires lapsed subscriptions (restoring the Free quota without touching files) and prunes counters.
- Back up PostgreSQL **and** the storage bucket/directory together.

Full instructions: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), Neon in
[`docs/NEON_SETUP.md`](docs/NEON_SETUP.md), object storage in
[`docs/STORAGE_SETUP.md`](docs/STORAGE_SETUP.md), payments in
[`docs/SAFEPAY_SETUP.md`](docs/SAFEPAY_SETUP.md), advertising in
[`docs/ADSENSE_SETUP.md`](docs/ADSENSE_SETUP.md), and the current verification status in
[`docs/TESTING_REPORT.md`](docs/TESTING_REPORT.md).

## Limitations (summary)

- Existing PDF text cannot be rewritten in place: edits are overlays, and the original text remains unless secure redaction is used.
- Scanned pages have no text until OCR runs; OCR accuracy depends on scan quality.
- Table, column and layout detection is heuristic; multi-column and designed layouts are approximate in conversions.
- Bookmarks and interactive form data are not carried into rebuilt exports yet.
- Work runs on the main browser thread for PDF rendering and some conversions. Very large documents (hundreds of pages or hundreds of megabytes) can be slow; pages are rendered lazily to limit memory.
- No certificate-based digital signatures, PDF/A, legacy Office formats, or form-data import/export in this build.

See `docs/SECURITY_AND_PRIVACY.md` for the security model and `docs/API.md` for the HTTP API.
