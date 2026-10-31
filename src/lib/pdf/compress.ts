/**
 * Compression. Two honest modes:
 * - lossless: structural re-save (object streams, unreferenced objects removed). Text and images are unchanged.
 * - raster presets: each page is re-rendered as a JPEG at a chosen resolution. Text becomes image data
 *   (not searchable or selectable). The result is only offered when it is actually smaller.
 */
import { PDFDocument } from "@cantoo/pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { canvasToBytes, pageSize, rasterize } from "./pdfjs";
import { abortError } from "./extract";

export type Preset = "low" | "medium" | "high";

export const PRESETS: Record<Preset, { scale: number; quality: number; label: string; text: string }> = {
  low: { scale: 1.6, quality: 0.9, label: "Low (best quality)", text: "~150 dpi JPEG q90. Best for printing; modest size reduction." },
  medium: { scale: 1.2, quality: 0.72, label: "Medium", text: "~110 dpi JPEG q72. Good balance for screens." },
  high: { scale: 0.9, quality: 0.5, label: "High (smallest)", text: "~65 dpi JPEG q50. Smallest file; visible quality loss." },
};

export async function rasterCompress(
  pdf: PDFDocumentProxy,
  preset: Preset,
  opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<Uint8Array> {
  const out = await PDFDocument.create({ updateMetadata: false });
  const cfg = PRESETS[preset];
  for (let i = 1; i <= pdf.numPages; i++) {
    if (opts.signal?.aborted) throw abortError();
    const page = await pdf.getPage(i);
    const size = pageSize(page);
    const canvas = await rasterize(page, { scale: cfg.scale, rotation: page.rotate });
    const jpeg = await canvasToBytes(canvas, "image/jpeg", cfg.quality);
    const w = size.rotate % 180 ? size.H : size.W;
    const h = size.rotate % 180 ? size.W : size.H;
    canvas.width = 0;
    canvas.height = 0;
    const img = await out.embedJpg(jpeg);
    const p = out.addPage([w, h]);
    p.drawImage(img, { x: 0, y: 0, width: w, height: h });
    opts.onProgress?.(i / pdf.numPages);
  }
  out.setProducer("PDF Pro");
  out.setCreator("PDF Pro");
  return new Uint8Array(await out.save({ useObjectStreams: true }));
}
