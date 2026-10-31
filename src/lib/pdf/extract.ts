/**
 * Browser-side extraction for conversions: positioned text in display orientation (per page),
 * and page renders. Coordinates are top-down points, matching layout.ts.
 */
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { layoutPage, type LayoutItem, type LayoutPage } from "./layout";
import { canvasToBytes, loadPdfJs, pageSize, rasterize } from "./pdfjs";

export function abortError(): Error {
  const e = new Error("The operation was cancelled.");
  e.name = "AbortError";
  return e;
}

export async function extractLayout(
  pdf: PDFDocumentProxy,
  opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void; pages?: number[] } = {},
): Promise<LayoutPage[]> {
  const pdfjs = await loadPdfJs();
  const out: LayoutPage[] = [];
  const indexes = opts.pages ?? Array.from({ length: pdf.numPages }, (_, i) => i);
  for (let k = 0; k < indexes.length; k++) {
    if (opts.signal?.aborted) throw abortError();
    const i = indexes[k];
    const page = await pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items: LayoutItem[] = [];
    for (const raw of tc.items) {
      if (!("str" in raw) || !raw.str) continue;
      const t = raw as { str: string; transform: number[]; width: number };
      const m = pdfjs.Util.transform(vp.transform, t.transform);
      const fs = Math.max(1, Math.hypot(m[2], m[3]));
      items.push({ str: t.str, x: m[4], y: m[5] - fs * 0.8, w: t.width, h: fs });
    }
    out.push(layoutPage(i, vp.width, vp.height, items));
    opts.onProgress?.((k + 1) / indexes.length);
  }
  return out;
}

/** PNG render of one page in display orientation. */
export async function renderPagePng(pdf: PDFDocumentProxy, index: number, scale = 2): Promise<Uint8Array> {
  const page = await pdf.getPage(index + 1);
  const canvas = await rasterize(page, { scale, rotation: page.rotate });
  const bytes = await canvasToBytes(canvas, "image/png");
  canvas.width = 0;
  canvas.height = 0;
  return bytes;
}

export function displayDims(page: Awaited<ReturnType<PDFDocumentProxy["getPage"]>>) {
  const s = pageSize(page);
  return s.rotate % 180 ? { w: s.H, h: s.W } : { w: s.W, h: s.H };
}
