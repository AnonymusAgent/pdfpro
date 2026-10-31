# PDF Pro — HTTP API

All endpoints are JSON, served by the Next.js route handlers in `src/app/api`. Document content is **never** sent to these endpoints: documents are processed in the browser. The API stores metadata, settings, saved signature images you explicitly save, and a processing log.

Errors use one shape: `{ "error": "human-readable message" }` with an HTTP status code (400 validation, 404 not found, 413 too large, 500/503 server or database problems).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness check. Returns `{ "ok": true }` when PostgreSQL answers. |
| GET | `/api/documents` | Recent document metadata (max 100, newest first). |
| POST | `/api/documents` | Record an opened document. Upserts by `name` + `size`. |
| PATCH | `/api/documents` | Star/unstar or rename. |
| DELETE | `/api/documents?id=` | Remove a history entry (the file itself is never stored). |
| GET | `/api/settings` | Shared preferences. |
| PUT | `/api/settings` | Update preferences (whitelisted keys only). |
| GET | `/api/signatures` | Saved signature images (max 20). |
| POST | `/api/signatures` | Save a PNG/JPEG signature data URL (≤ 700 KB). |
| DELETE | `/api/signatures?id=` | Delete a saved signature. |
| GET | `/api/jobs` | Processing log (max 50, newest first). |
| POST | `/api/jobs` | Append a processing log entry. |

## Documents

`POST /api/documents`

```json
{ "name": "report.pdf", "size": 1048576, "pages": 12, "kind": "pdf" }
```

Rules: `name` 1–255 characters; `size` integer 0–2³¹−1; `pages` integer 0–100000; `kind` one of `pdf, docx, xlsx, pptx, image, txt`. Returns `201` with `{ "document": {...} }`.

`PATCH /api/documents` — `{ "id": 3, "starred": true }` or `{ "id": 3, "name": "New name" }`. Returns `404` for an unknown id.

## Settings

`PUT /api/settings` accepts only these keys:

| Key | Type / range |
|---|---|
| `theme` | `"light"` or `"dark"` |
| `defaultZoom` | number, 25–400 |
| `defaultView` | `"continuous"`, `"single"`, or `"two-page"` |
| `maxFileMB` | number, 1–500 |
| `autosave` | boolean |
| `ocrLang` | three-letter codes joined by `+`, e.g. `eng` or `eng+spa` |

Unknown keys → `400` listing them. Invalid values → `400` listing the keys.

## Signatures

`POST /api/signatures`

```json
{ "name": "My signature", "kind": "draw", "dataUrl": "data:image/png;base64,..." }
```

`dataUrl` must be a PNG or JPEG data URL and at most 700,000 characters (`413` otherwise). `kind` is `draw`, `type`, or `upload`.

## Processing log

`POST /api/jobs`

```json
{ "kind": "export-pdf", "fileName": "report.pdf", "inputSize": 1000, "outputSize": 1200, "status": "completed", "message": "Annotations embedded" }
```

`kind` matches `^[a-z0-9-]{2,40}$`; `status` is `completed`, `failed`, or `cancelled`; `fileName` is reduced to its base name; `message` is truncated to 300 characters. Log messages must not contain document text.

## Chrome extension hand-off protocol

The extension exposes this to the PDF Pro web app through `chrome.runtime.sendMessage` (only origins listed in `externally_connectable` can reach it):

| Request | Response |
|---|---|
| `{ "type": "PDFPRO_PING" }` | `{ "ok": true, "version": "1.1.0" }` |
| `{ "type": "PDFPRO_TAKE_HANDOFF", "id": "<uuid>" }` | `{ "ok": true, "name": "file.pdf", "base64": "..." }` — one-time: the stored copy is deleted when read. Hand-offs expire after 15 minutes. |

The service worker re-checks the sender origin against the configured PDF Pro origin and the localhost origins before answering.
