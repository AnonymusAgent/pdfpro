# PDF Pro — Editor, Converter & OCR

PDF Pro is a browser-based PDF workspace (Next.js App Router + TypeScript + Tailwind) with a Manifest V3 Chrome extension. Documents are processed locally in the browser. The server stores only metadata, settings, saved signatures you choose to keep, and a processing log in PostgreSQL.

## Feature status

Legend: ✅ implemented and covered by an automated test · 🟡 implemented but approximate or partially limited · ❌ not implemented in this build.

| Area | Status | Notes |
|---|---|---|
| Open, view, search, zoom, rotate, continuous / single / two-page view | ✅ | PDF.js rendering, lazy pages, text layer selection, outline and attachments panels |
| Password-protected PDFs (open) | ✅ | Password prompt; incorrect password reported |
| Multiple open documents, isolated edit state, undo/redo | ✅ | Each document has its own history |
| Autosave and crash/refresh recovery | ✅ | IndexedDB; restore or discard on the Editor and Recent pages |
| Annotations: highlight, underline, strike, draw, rectangle, ellipse, line, arrow, notes, stamps, text, links, form fields | ✅ | Export embeds them; rotation-aware placement tested |
| Insert and move/resize/rotate images and signatures | ✅ | PNG/JPEG; aspect ratio kept; rotation exported |
| Edit existing text | 🟡 | Replacement overlay with a white cover. The original text remains unless secure export is used |
| Page management: blank, duplicate, delete, reorder, rotate, extract, insert and replace from another PDF | ✅ | Replace keeps annotations on the page; review them |
| Crop, paper size (A4/A3/Letter/Legal), margins, background | ✅ | Crop applied as CropBox; resize embeds pages |
| Watermark, header/footer, page numbers, Bates numbers | ✅ | Editor export and batch tools |
| Secure redaction (rasterize + verify) | ✅ | Verified by text extraction before download |
| Visual-only redaction / whiteout | 🟡 | Covers only; text remains. Labelled as such |
| Merge, split (ranges, every page), extract | ✅ | Verified outputs; ZIP for multi-file results |
| Compression: lossless, low/medium/high raster presets | 🟡 | Raster presets turn text into images; never reported smaller unless smaller |
| Batch: rotate, watermark, page numbers, lossless, text | ✅ | Per-file status and ZIP download |
| OCR (Tesseract.js) with preprocessing, rotation detection, cancel | ✅ | English bundled; other languages downloaded from CDN once |
| OCR review, low-confidence flagging, export TXT/MD/DOCX/XLSX/CSV, searchable PDF | ✅ | Searchable PDF positions words from OCR boxes |
| PDF → DOCX (editable and layout) | ✅ | Parsed back with Mammoth in tests |
| PDF → XLSX (per table / combined), CSV | 🟡 | Table detection is heuristic; numeric cells become numbers |
| PDF → PPTX (editable and image) | ✅ | Same page size; complex layouts need adjustment |
| PDF → TXT, Markdown, HTML, RTF, ODT, EPUB, PNG, JPEG, TIFF, SVG | ✅ | Each output validated |
| PDF → Searchable PDF | ✅ | Via the OCR workspace |
| PDF → PDF/A | ❌ | Needs a validated engine (Ghostscript/veraPDF). Clearly labelled |
| DOCX / XLSX / PPTX / TXT / MD / HTML / PNG / JPEG / TIFF → PDF; several → one PDF | 🟡 | Text, tables, pictures and positions mapped; fonts approximated |
| Legacy DOC / XLS / PPT | ❌ | Needs LibreOffice (not configured). Rejected with an explanation |
| Electronic (visual) signatures: draw, type, upload, save with consent | ✅ | Not certificate-based |
| Certificate-based digital signatures | ❌ | Not in this build |
| Password protection (AES-256) and password removal with authorization | ✅ | Open password and permissions; verified |
| Metadata clean-up on export | ✅ | Rebuilt file carries no source document information |
| Compare two PDFs (visual pixel diff + line-level text diff) | ✅ | Visual limited to 40 pages |
| Form fields: create | ✅ | Real AcroForm text fields |
| Form fields: fill existing forms, import/export form data | ❌ | Not implemented |
| Bookmarks in rebuilt exports | ❌ | Bookmarks are shown and used for navigation, but are not carried into exports that rebuild pages |
| Optional-content layers (visibility toggles) | ❌ | Not implemented |
| Chrome extension (MV3): context menus, popup, hand-off to editor | 🟡 | Packaging and manifest verified by tests; not yet exercised in a real Chrome profile (see Testing) |
| Accounts, cloud sync, teams, subscriptions | ❌ | Not in scope for this build |

## Architecture

```
src/
  app/                       Next.js routes (App Router)
    page.tsx                 Home / dashboard
    editor/ convert/ ocr/ tools/ sign/ compare/ recent/ settings/ help/ extension/
    api/                     documents, settings, signatures, jobs, health (PostgreSQL via Drizzle)
  components/
    shell.tsx                Header, navigation, theme, toasts, confirm dialogs
    ui.tsx                   Shared UI primitives (buttons, dialogs, dropzone, notices)
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
src/db/                      Drizzle schema and client
tests/unit/                  Vitest: geometry, layout, export, operations, conversions, validation
tests/e2e/                   Playwright: browser workflows against the production build
docs/                        API reference and security/privacy notes
```

Processing services are plain TypeScript modules that do not depend on React, so the same code runs in the browser, in Web Workers (planned), and in Node tests. Expensive browser operations run on the main thread today; see Limitations.

## Setup

Prerequisites: Node.js 22 or newer, PostgreSQL 14+.

```bash
npm install
cp .env.example .env            # set DATABASE_URL if your database differs
node scripts/setup-assets.mjs   # copies offline runtime assets into public/ and generates extension icons
npx drizzle-kit push            # creates the tables in DATABASE_URL
npm run dev                     # development server on http://localhost:3000
```

Production:

```bash
npm run build
npm run start                   # serves on http://localhost:3000
```

Re-run `node scripts/setup-assets.mjs` after upgrading `pdfjs-dist`, `tesseract.js`, `tesseract.js-core` or `@tesseract.js-data/eng`.

## Testing

```bash
npm run test:unit               # Vitest: 53 tests (geometry, layout, export, operations, conversions, validation)
npx playwright install chromium # once; on Linux also: sudo npx playwright install-deps chromium
npm run build && npm run test:e2e   # Playwright: 9 browser workflows against the production build
npx tsc --noEmit                # type check
npx eslint .                    # lint (0 errors; a few intentional <img> warnings for data URLs)
```

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

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string used by Drizzle and the API routes |

The application reads no other secrets. Nothing is embedded in the client bundle.

## Deployment notes

- Serve over HTTPS. Browser features (IndexedDB, clipboard, Web Workers for WebAssembly) require a secure context outside localhost.
- Run `node scripts/setup-assets.mjs` as part of the build pipeline so PDF.js and Tesseract assets are present in `public/vendor`.
- The application makes no server-side document conversions and needs no conversion workers, queues or object storage.
- LibreOffice, Ghostscript or another engine is needed only for the features marked ❌ above; they are not wired into this build.
- Download the extension ZIP from the deployed origin so its `externally_connectable` list contains that origin.

## Limitations (summary)

- Existing PDF text cannot be rewritten in place: edits are overlays, and the original text remains unless secure redaction is used.
- Scanned pages have no text until OCR runs; OCR accuracy depends on scan quality.
- Table, column and layout detection is heuristic; multi-column and designed layouts are approximate in conversions.
- Bookmarks and interactive form data are not carried into rebuilt exports yet.
- Work runs on the main browser thread for PDF rendering and some conversions. Very large documents (hundreds of pages or hundreds of megabytes) can be slow; pages are rendered lazily to limit memory.
- No certificate-based digital signatures, PDF/A, legacy Office formats, or form-data import/export in this build.

See `docs/SECURITY_AND_PRIVACY.md` for the security model and `docs/API.md` for the HTTP API.
