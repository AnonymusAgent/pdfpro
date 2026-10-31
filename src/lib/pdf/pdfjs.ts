/**
 * PDF.js service: opening (with password handling), rendering, thumbnails, text extraction,
 * search, outline and attachments. Browser-first; module top level has no DOM side effects,
 * so the same code can be exercised from Node tests.
 */
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Box } from "./types";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/** Served from /public — copied there by scripts/setup-assets.mjs so the app works offline. */
export const PDF_WORKER_URL = "/vendor/pdf.worker.min.mjs";
/** Caps canvas memory for very large pages (posters, engineering drawings). */
const MAX_RENDER_PIXELS = 16_000_000;

let pdfjsPromise: Promise<PdfJsModule> | null = null;

export function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((m) => {
      if (typeof window !== "undefined") m.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
      return m;
    });
  }
  return pdfjsPromise;
}

export type PdfOpenErrorCode = "password-required" | "password-incorrect" | "invalid" | "too-large" | "unknown";

export class PdfOpenError extends Error {
  readonly code: PdfOpenErrorCode;
  constructor(message: string, code: PdfOpenErrorCode) {
    super(message);
    this.name = "PdfOpenError";
    this.code = code;
  }
}

/** True if "%PDF-" appears in the first 1 KB (the spec allows a short preamble). */
export function hasPdfHeader(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 1024);
  for (let i = 0; i + 4 < n; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) {
      return true;
    }
  }
  return false;
}

export async function openPdf(data: ArrayBuffer | Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  // PDF.js transfers the buffer to its worker, so always hand it a private copy.
  const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
  if (!hasPdfHeader(bytes)) throw new PdfOpenError("This file is not a PDF (no %PDF header found).", "invalid");
  const pdfjs = await loadPdfJs();
  try {
    return await pdfjs.getDocument({ data: bytes, password }).promise;
  } catch (err: unknown) {
    const e = err as { name?: string; code?: number; message?: string };
    if (e?.name === "PasswordException") {
      const incorrect = e.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
      throw new PdfOpenError(
        incorrect ? "Incorrect password." : "This PDF is password-protected. Enter its password to open it.",
        incorrect ? "password-incorrect" : "password-required",
      );
    }
    if (e?.name === "InvalidPDFException" || e?.name === "MissingPDFException") {
      throw new PdfOpenError("The PDF is damaged or incomplete and cannot be opened.", "invalid");
    }
    throw new PdfOpenError(`Could not open the PDF: ${e?.message ?? "unknown error"}`, "unknown");
  }
}

/** View box (CropBox ∩ MediaBox as pdf.js resolves it) and the page's own /Rotate. */
export function pageSize(page: PDFPageProxy): { x0: number; y0: number; W: number; H: number; rotate: number } {
  const [x0, y0, x1, y1] = page.view;
  return { x0, y0, W: x1 - x0, H: y1 - y0, rotate: page.rotate };
}

/** Renders a page into a canvas at `opts.scale` CSS px per point, rotated clockwise by `rotation`. */
export function renderPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  opts: { scale: number; rotation: number; dpr?: number },
): RenderTask {
  const dpr = opts.dpr ?? 1;
  const base = page.getViewport({ scale: 1, rotation: opts.rotation });
  let scale = opts.scale * dpr;
  const area = base.width * base.height * scale * scale;
  if (area > MAX_RENDER_PIXELS) scale *= Math.sqrt(MAX_RENDER_PIXELS / area);
  const vp = page.getViewport({ scale, rotation: opts.rotation });
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  canvas.style.width = `${base.width * opts.scale}px`;
  canvas.style.height = `${base.height * opts.scale}px`;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 2D context is unavailable in this browser.");
  return page.render({ canvasContext: ctx, viewport: vp, canvas });
}

/** Frees pdf.js resources for a document handle (no-op if the build does not expose destroy()). */
export function releasePdf(p: PDFDocumentProxy): void {
  const handle = p as unknown as { destroy?: () => Promise<void> };
  void handle.destroy?.()?.catch?.(() => undefined);
}

/** Offscreen render used for exports, OCR and thumbnails. */
export async function rasterize(page: PDFPageProxy, opts: { scale: number; rotation: number }): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  await renderPage(page, canvas, { ...opts, dpr: 1 }).promise;
  return canvas;
}

export function canvasToBytes(canvas: HTMLCanvasElement, type: "image/png" | "image/jpeg", quality = 0.92): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) return reject(new Error("Canvas export failed (out of memory?)."));
        resolve(new Uint8Array(await blob.arrayBuffer()));
      },
      type,
      quality,
    );
  });
}

const thumbCache = new Map<string, string>();
const THUMB_CACHE_LIMIT = 400;

/** Lazily-rendered, LRU-cached JPEG thumbnail data URL. */
export async function thumbnailDataUrl(page: PDFPageProxy, key: string, rotation: number, width = 140): Promise<string> {
  const cacheKey = `${key}:${rotation}:${width}`;
  const hit = thumbCache.get(cacheKey);
  if (hit) return hit;
  const base = page.getViewport({ scale: 1, rotation });
  const canvas = await rasterize(page, { scale: width / base.width, rotation });
  const url = canvas.toDataURL("image/jpeg", 0.8);
  canvas.width = 0;
  canvas.height = 0;
  thumbCache.set(cacheKey, url);
  if (thumbCache.size > THUMB_CACHE_LIMIT) thumbCache.delete(thumbCache.keys().next().value as string);
  return url;
}

export function clearThumbnailCache(prefix: string) {
  for (const k of [...thumbCache.keys()]) if (k.startsWith(prefix)) thumbCache.delete(k);
}

/* ------------------------------------------------------------------ text */

export type PageTextItem = {
  str: string;
  /** normalized, unrotated page space, top-left origin */
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
};

export type PageText = {
  items: PageTextItem[];
  /** Concatenated text used for searching; items map to offsets via `starts`. */
  text: string;
  starts: number[];
};

export async function getPageText(page: PDFPageProxy): Promise<PageText> {
  const [x0, y0, x1, y1] = page.view;
  const W = x1 - x0;
  const H = y1 - y0;
  const tc = await page.getTextContent();
  const items: PageTextItem[] = [];
  const starts: number[] = [];
  let text = "";
  let prevEnd = 0;
  let prevBase = 0;
  let first = true;
  for (const raw of tc.items) {
    if (!("str" in raw) || !raw.str) continue;
    const t = raw as { str: string; transform: number[]; width: number; height: number };
    const [, , c, d, e, f] = t.transform;
    const fontSize = Math.abs(d) || Math.hypot(c, d) || t.height || 10;
    const h = Math.abs(t.height) || fontSize;
    const top = f + h;
    items.push({
      str: t.str,
      x: (e - x0) / W,
      y: (y0 + H - top) / H,
      w: t.width / W,
      h: h / H,
      fontSize,
    });
    if (!first) {
      const sameLine = Math.abs(f - prevBase) < h * 0.5;
      if (!sameLine || e - prevEnd > h * 0.2) text += " ";
    }
    starts.push(text.length);
    text += t.str;
    prevEnd = e + t.width;
    prevBase = f;
    first = false;
  }
  return { items, text, starts };
}

export type SearchHit = { page: number; text: string; boxes: Box[] };

/** Finds all occurrences of `query` on a page; each hit contains one box per covered text run. */
export function findInPage(pt: PageText, query: string, pageIndex: number, caseSensitive = false): SearchHit[] {
  if (!query) return [];
  const hay = caseSensitive ? pt.text : pt.text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const hits: SearchHit[] = [];
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    const s = idx;
    const e = idx + needle.length;
    const boxes: Box[] = [];
    pt.items.forEach((it, i) => {
      const o = pt.starts[i];
      const len = it.str.length;
      const a = Math.max(s, o);
      const b = Math.min(e, o + len);
      if (len === 0 || b <= a) return;
      const f0 = (a - o) / len;
      const f1 = (b - o) / len;
      boxes.push({ x: it.x + it.w * f0, y: it.y, w: it.w * (f1 - f0), h: it.h });
    });
    if (boxes.length) hits.push({ page: pageIndex, text: pt.text.slice(s, e), boxes });
    idx = hay.indexOf(needle, idx + needle.length);
  }
  return hits;
}

/** Text item under a normalized page-space point (used for "Edit existing text"). */
export function itemAt(pt: PageText, p: { x: number; y: number }): PageTextItem | null {
  let best: PageTextItem | null = null;
  for (const it of pt.items) {
    if (p.x >= it.x && p.x <= it.x + it.w && p.y >= it.y && p.y <= it.y + it.h) {
      if (!best || it.w * it.h < best.w * best.h) best = it;
    }
  }
  return best;
}

/* ------------------------------------------------------- outline / info */

export type OutlineNode = { title: string; page: number | null; children: OutlineNode[] };

type RawOutline = { title: string; dest: unknown; items?: RawOutline[] };

export async function getOutline(pdf: PDFDocumentProxy): Promise<OutlineNode[]> {
  const raw = (await pdf.getOutline()) as RawOutline[] | null;
  if (!raw) return [];
  return walkOutline(pdf, raw);
}

async function walkOutline(pdf: PDFDocumentProxy, nodes: RawOutline[]): Promise<OutlineNode[]> {
  const out: OutlineNode[] = [];
  for (const n of nodes) {
    let page: number | null = null;
    try {
      let dest: unknown = n.dest;
      if (typeof dest === "string") dest = await pdf.getDestination(dest);
      if (Array.isArray(dest) && dest[0]) page = await pdf.getPageIndex(dest[0] as never);
    } catch {
      page = null;
    }
    out.push({ title: n.title || "(untitled)", page, children: await walkOutline(pdf, n.items ?? []) });
  }
  return out;
}

export async function getAttachments(pdf: PDFDocumentProxy): Promise<{ name: string; bytes: Uint8Array }[]> {
  const att = (await pdf.getAttachments()) as Record<string, { filename: string; content: Uint8Array }> | null;
  if (!att) return [];
  return Object.values(att).map((a) => ({ name: a.filename, bytes: a.content }));
}

export async function getDocumentInfo(pdf: PDFDocumentProxy): Promise<Record<string, string>> {
  const meta = await pdf.getMetadata();
  const info = (meta.info ?? {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof info[k] === "string" ? (info[k] as string) : "");
  return {
    title: pick("Title"),
    author: pick("Author"),
    subject: pick("Subject"),
    keywords: pick("Keywords"),
    creator: pick("Creator"),
    producer: pick("Producer"),
    creationDate: pick("CreationDate"),
  };
}
