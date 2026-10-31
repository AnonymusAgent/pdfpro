/**
 * Browser-side export orchestration: renders redaction rasters with pdf.js, runs the export
 * engine, and verifies redaction results by extracting text from the output.
 */
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildEditedPdf, redactedUids, type ExportOptions, type ExportResult, type RasterPage } from "./export";
import { canvasToBytes, getPageText, openPdf, pageSize, rasterize } from "./pdfjs";
import { normRot } from "./geometry";
import type { EditState, SourceInfo } from "./types";

export type ExportSource = {
  bytes: ArrayBuffer;
  sources: SourceInfo[];
  pdfs: Record<string, PDFDocumentProxy>;
};

/**
 * Renders each redacted page unrotated at `scale`, paints the redaction rectangles into the
 * pixels, and returns JPEG bytes. The text layer of these pages is not carried into the output.
 */
export async function renderRedactionRasters(
  src: Pick<ExportSource, "pdfs">,
  edit: EditState,
  uids: string[],
  scale = 2,
): Promise<Record<string, RasterPage>> {
  const out: Record<string, RasterPage> = {};
  for (const uid of uids) {
    const entry = edit.pages.find((p) => p.uid === uid);
    if (!entry || entry.src === "blank") continue;
    const pdf = src.pdfs[entry.src];
    if (!pdf) throw new Error(`Source "${entry.src}" is not loaded; re-open the document.`);
    const page = await pdf.getPage(entry.index + 1);
    const { W, H } = { W: pageSize(page).W, H: pageSize(page).H };
    const canvas = await rasterize(page, { scale, rotation: 0 });
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable for redaction.");
    for (const a of edit.anns) {
      if (a.uid !== uid || a.type !== "redact") continue;
      ctx.fillStyle = "#000000";
      ctx.fillRect(a.x * canvas.width, a.y * canvas.height, a.w * canvas.width, a.h * canvas.height);
    }
    const bytes = await canvasToBytes(canvas, "image/jpeg", 0.92);
    out[uid] = { bytes, W, H };
    canvas.width = 0;
    canvas.height = 0;
  }
  return out;
}

export async function exportDocument(
  doc: ExportSource,
  options: ExportOptions,
  opts: { secure: boolean; edit: EditState },
): Promise<ExportResult> {
  const sources: Record<string, Uint8Array> = { main: new Uint8Array(doc.bytes.slice(0)) };
  for (const s of doc.sources) sources[s.id] = new Uint8Array(s.bytes.slice(0));
  const uids = redactedUids(opts.edit);
  const rasters = opts.secure && uids.length ? await renderRedactionRasters(doc, opts.edit, uids) : undefined;
  return buildEditedPdf({ sources, edit: opts.edit, rasters, options });
}

/**
 * Checks that text under secure redaction marks is no longer extractable from the output.
 * Only meaningful for secure exports (rasterized pages); visual-only covers keep their text.
 */
export async function verifyRedaction(
  doc: ExportSource,
  edit: EditState,
  outBytes: Uint8Array,
): Promise<{ ok: boolean; leaked: string[]; checkedPages: number }> {
  const hidden = new Set<string>();
  for (const ann of edit.anns) {
    if (ann.type !== "redact") continue;
    const entry = edit.pages.find((p) => p.uid === ann.uid);
    if (!entry || entry.src === "blank") continue;
    const pdf = doc.pdfs[entry.src];
    if (!pdf) continue;
    const pt = await getPageText(await pdf.getPage(entry.index + 1));
    for (const item of pt.items) {
      const cx = item.x + item.w / 2;
      const cy = item.y + item.h / 2;
      if (cx >= ann.x && cx <= ann.x + ann.w && cy >= ann.y && cy <= ann.y + ann.h) {
        for (const word of item.str.split(/\s+/)) if (word.length >= 3) hidden.add(word.toLowerCase());
      }
    }
  }
  const redacted = edit.pages
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => redactedUids(edit).includes(p.uid));
  const out = await openPdf(outBytes);
  const leaked = new Set<string>();
  for (const { i } of redacted) {
    const text = (await getPageText(await out.getPage(i + 1))).text.toLowerCase();
    for (const w of hidden) if (text.includes(w)) leaked.add(w);
  }
  return { ok: leaked.size === 0, leaked: [...leaked], checkedPages: redacted.length };
}

export { normRot };
