# PDF Pro — Security and Privacy

This document describes what PDF Pro does with your files, what it stores, what it does not do, and the limits of each security feature. It is written to be checked, not to reassure: where a feature is not implemented, it says so.

## 1. Where processing happens

| Operation | Where it runs | Leaves the browser? |
|---|---|---|
| Opening, viewing, searching, annotating, editing | Browser (PDF.js, pdf-lib) | No |
| Export and secure redaction | Browser | No |
| Conversions (DOCX, XLSX, PPTX, text, images, EPUB, ODT, SVG, TIFF) | Browser (docx, ExcelJS, PptxGenJS, JSZip, Mammoth) | No |
| OCR | Browser (Tesseract.js WebAssembly) | No (see §5 for the language download) |
| Merge, split, compress, batch | Browser | No |
| Password protection and removal | Browser (pdf-lib fork with the standard security handler) | No |
| Recent list, settings, saved signatures, processing log | Server → PostgreSQL | Metadata only |

No document content is sent to an analytics service. The application does not use uploaded documents for model training, and it has no server-side conversion queue that would hold your files.

## 2. What is stored, and where

| Data | Location | Retention |
|---|---|---|
| Open documents and unsaved edits | Memory of the browser tab | Until the tab is closed or the document is closed |
| Autosaved recovery copy (file bytes + edit list) | Browser IndexedDB (`pdfpro`) | Until you export the document, discard the copy, or delete it on the Recent page |
| Recently opened documents (name, size, pages, starred) | PostgreSQL `documents` | Until you remove the entry |
| Saved signature image | PostgreSQL `signatures` | Only if you tick the consent box and click Save; deletable |
| Settings | Browser localStorage, and PostgreSQL `settings` (whitelisted keys) | Until changed |
| Processing log (operation, file base name, sizes, short message) | PostgreSQL `jobs` | Until removed by a database administrator |
| Extension hand-off copy | Extension IndexedDB (`pdfpro-extension`) | Deleted when the web app reads it, or after 15 minutes |

The server creates **no temporary files** and keeps **no copies of uploaded documents**; documents are not uploaded for the tools.

## 3. What is logged

- Server logs: route errors log the error class and digest only. The processing log stores the operation, a base file name, sizes and a short message; it must not contain document text (API validation truncates messages to 300 characters).
- Browser console: error messages for failed operations. Document text is not logged by the application.
- Test reports: Playwright and Vitest output contains file names and assertion messages. Fixtures in `tests/fixtures` are synthetic (generated shapes and sample text).

## 4. File validation and malicious input

- **Type**: files are identified by their signature (`%PDF-`, PNG, JPEG, TIFF, ZIP) and by the parser that opens them, not by extension alone.
- **Size**: a configurable limit (default 100 MB, Settings) is enforced before the file is read into memory. Extension hand-offs are limited to 40 MB.
- **Outputs**: every generated file is opened by a real parser before it is offered for download (`src/lib/pdf/validate.ts`): pdf-lib for PDF, Mammoth for DOCX, ExcelJS for XLSX, JSZip structure checks for PPTX/ODT/EPUB, and signature/structure checks for images, SVG, RTF and HTML.
- **Parsing**: PDF.js and the other parsers run in the browser sandbox. Malformed PDFs produce a clear "damaged or incomplete" error rather than a crash.
- **HTML and markup inputs**: converted to a document model and rendered as PDF text or DOM text; no HTML from user files is inserted into the page as markup. The HTML export escapes all text.
- **Extension**: the hand-off request is only answered for allow-listed origins, and only for an unexpired one-time identifier.

## 5. Network use

- The only third-party network request the app makes by design is the **OCR language download**: languages other than English are fetched once from the jsDelivr CDN by Tesseract.js. Only language model data is requested; no document content is sent. English is bundled in `public/vendor/tessdata` and works offline. Self-host the language files to remove the CDN dependency entirely.
- The extension can fetch a PDF from a site you explicitly allow (optional host permission). It sends the PDF only to the local editor tab, never elsewhere.

## 6. Security features and their limits

### Secure redaction
- Redaction marks are removed by **rasterizing each redacted page**: the page is rendered to an image with the marks painted in, and that image replaces the page. The output page has no text layer for that page, so text under the mark cannot be extracted or searched.
- The export is **verified**: the words under each mark are extracted from the original, and the output page is checked to ensure none of them remain. A failed check blocks the download.
- Limits: rasterized pages are no longer vector or searchable; links and form fields on those pages are not preserved. Pages without marks keep their text.
- "Whiteout" and the plain (non-secure) redaction export are **visual only**. The text remains in the file under the cover. The UI says so.

### Password protection
- Encryption uses the **standard PDF security handler** (AES-256 via the `@cantoo/pdf-lib` encryption support). An open password is required when set. Owner and permission settings are advisory: compliant readers enforce them, some viewers ignore them.
- Export verifies that an encrypted file with an open password does not open without it.
- Passwords are not stored. If the owner password is lost, the file cannot be recovered by PDF Pro.
- Removing a password requires the current password and an explicit authorization confirmation. The tool does not bypass protection it was not given the password for.

### Electronic signatures vs. digital signatures
- **Electronic (visual) signatures** are supported: drawn, typed or uploaded images placed on pages. They show a signature visually and do not prove identity or detect later edits.
- **Certificate-based digital signatures (PKCS#7 / PAdES)** are **not implemented**. They require a signing certificate, a trust model and validation, which this build does not provide.

### Metadata
- Exports are rebuilt page by page, so the original document information dictionary and XMP packet are not copied. The "Clean metadata" option removes creator and producer names. Document title/author are set only when you enter them.
- Limitation: bookmarks and interactive form data are not carried into rebuilt exports yet (documented in the UI and in Help).

## 7. Web application security

- Route handlers validate input (types, lengths, ranges, allow-lists) and return generic error messages for database failures.
- Settings are written through a key allow-list.
- Signature uploads are restricted to PNG/JPEG data URLs and a size limit.
- No secrets are embedded in the client bundle. `NEXT_PUBLIC_*` variables are not required for operation.
- Production builds should be served over HTTPS. Set a restrictive Content-Security-Policy at your reverse proxy; the app works with `script-src 'self'` plus `'wasm-unsafe-eval'` for PDF.js and Tesseract WebAssembly.

## 8. Dependencies

- `npm audit --omit=dev` reports advisories in the production dependency tree at the time of writing (10 findings, including one critical and five high). The critical and libvips findings come from `sharp`, an **optional** dependency of Next.js that provides `next/image` optimization. This application does not import `next/image`, so that code path is not reachable in this build, but the advisory should still be closed by upgrading Next.js before production. Other findings are transitive dependencies of the document libraries and the PostgreSQL stack. Review each one with `npm audit --omit=dev` before launch. Upgrading was not performed as part of this audit because it changes runtime behavior of PDF parsing and rendering and needs regression testing on real documents.
- Licenses: pdf.js (Apache-2.0), pdf-lib fork (MIT), Tesseract.js (Apache-2.0), eng language data (Apache-2.0), docx, ExcelJS, PptxGenJS, JSZip, Mammoth, UTIF (MIT). Check each package's license file before redistribution.

## 9. Reporting a problem

If you find a way to make PDF Pro expose document content, bypass a redaction, or accept a hand-off from an unlisted origin, treat it as a security issue. Do not include real document content in a report; a minimal synthetic file that reproduces the problem is sufficient.
