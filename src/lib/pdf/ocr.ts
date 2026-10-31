/**
 * OCR pipeline (Tesseract.js, runs in the browser; language data is served from /public).
 *
 * - Preprocessing: grayscale, percentile contrast stretch, Otsu binarization, isolated-speck removal
 *   (noise reduction), and projection-profile deskew (±4°).
 * - Orientation: Tesseract's automatic rotation detection (rotateAuto).
 * - Output: words with bounding boxes in PDF points, so searchable overlays line up with the scan.
 * - Cancellable between pages; terminates the worker on cancel.
 */
import { createWorker } from "tesseract.js";
import { PDFDocument, StandardFonts, type PDFFont } from "@cantoo/pdf-lib";
import { canvasToBytes } from "./pdfjs";
import { safeFontText } from "./export";

export const OCR_LANGUAGES = [
  { code: "eng", label: "English" },
  { code: "spa", label: "Spanish" },
  { code: "fra", label: "French" },
  { code: "deu", label: "German" },
  { code: "ita", label: "Italian" },
  { code: "por", label: "Portuguese" },
  { code: "nld", label: "Dutch" },
];

export type OcrWord = { text: string; x: number; y: number; w: number; h: number; conf: number };

export type OcrPageResult = {
  index: number;
  text: string;
  confidence: number;
  widthPt: number;
  heightPt: number;
  words: OcrWord[];
  lowConfidenceWords: number;
  skewDeg: number;
};

export type OcrProgress = { page: number; pages: number; pct: number; status: string };

export const LOW_CONFIDENCE = 60;

type Node = Record<string, unknown>;

/** Collects word-level results from Tesseract's block → paragraph → line → word hierarchy. */
export function collectWords(data: unknown): { text: string; conf: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[] {
  const out: { text: string; conf: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    const node = n as Node;
    for (const k of ["blocks", "paragraphs", "lines", "words"]) {
      const child = node[k];
      if (Array.isArray(child) && child.length) {
        walk(child);
        return;
      }
    }
    const bbox = node.bbox as { x0: number; y0: number; x1: number; y1: number } | undefined;
    if (bbox && typeof node.text === "string" && node.text.trim()) {
      out.push({ text: node.text.trim(), conf: Number(node.confidence ?? 0), bbox });
    }
  };
  walk(data);
  return out;
}

/** Grayscale, contrast stretch, Otsu threshold, speck removal and deskew. Returns a new canvas. */
export function preprocessForOcr(src: HTMLCanvasElement, opts: { deskew: boolean; denoise: boolean }): { canvas: HTMLCanvasElement; skewDeg: number } {
  const w = src.width;
  const h = src.height;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  if (!sctx) throw new Error("Canvas is unavailable for OCR preprocessing.");
  const data = sctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = ((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000) | 0;
  }
  // Contrast stretch between the 1st and 99th percentiles.
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const pct = (q: number) => {
    let acc = 0;
    const target = q * gray.length;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= target) return i;
    }
    return 255;
  };
  const lo = pct(0.01);
  const hi = Math.max(lo + 1, pct(0.99));
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.max(0, Math.min(255, Math.round(((gray[i] - lo) * 255) / (hi - lo))));
  }
  // Otsu threshold.
  const h2 = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) h2[gray[i]]++;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * h2[t];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += h2[t];
    if (!wB) continue;
    const wF = gray.length - wB;
    if (!wF) break;
    sumB += t * h2[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) ink[i] = gray[i] <= thr ? 1 : 0;

  if (opts.denoise) {
    const copy = ink.slice();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!copy[i]) continue;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dy || dx) && copy[i + dy * w + dx]) n++;
        if (n <= 1) ink[i] = 0;
      }
    }
  }

  const skewDeg = opts.deskew ? estimateSkew(ink, w, h) : 0;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  if (!octx) throw new Error("Canvas is unavailable for OCR preprocessing.");
  const img = octx.createImageData(w, h);
  for (let i = 0, p = 0; p < ink.length; i += 4, p++) {
    const v = ink[p] ? 0 : 255;
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  if (Math.abs(skewDeg) >= 0.3) return { canvas: rotateCanvas(out, -skewDeg), skewDeg };
  return { canvas: out, skewDeg: 0 };
}

/** Projection-profile skew estimate: the angle whose row sums are most peaked. */
function estimateSkew(ink: Uint8Array, w: number, h: number): number {
  const step = Math.max(1, Math.round(w / 700));
  const pts: number[] = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) if (ink[y * w + x]) pts.push(x, y);
  }
  if (pts.length < 200) return 0;
  let bestAngle = 0;
  let bestScore = -1;
  const rows = Math.ceil(Math.sqrt(w * w + h * h) / step) + 2;
  for (let a = -4; a <= 4.001; a += 0.25) {
    const rad = (a * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const counts = new Float64Array(rows);
    for (let k = 0; k < pts.length; k += 2) {
      const x = pts[k];
      const y = pts[k + 1];
      const r = Math.round(y * cos - x * sin) + rows / 2;
      if (r >= 0 && r < rows) counts[r]++;
    }
    let score = 0;
    for (let r = 0; r < rows; r++) score += counts[r] * counts[r];
    if (score > bestScore) {
      bestScore = score;
      bestAngle = a;
    }
  }
  return bestAngle;
}

function rotateCanvas(src: HTMLCanvasElement, deg: number): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable for rotation.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

export type OcrPageInput = {
  index: number;
  widthPt: number;
  heightPt: number;
  /** Renders the page at a resolution suitable for OCR (typically 2–3 px per point). */
  render: () => Promise<HTMLCanvasElement>;
};

export async function runOcr(opts: {
  pages: OcrPageInput[];
  langs: string[];
  preprocess: boolean;
  rotateAuto: boolean;
  signal?: AbortSignal;
  onProgress?: (p: OcrProgress) => void;
}): Promise<{ results: OcrPageResult[]; cancelled: boolean }> {
  const langs = opts.langs.length ? opts.langs : ["eng"];
  const local = langs.every((l) => l === "eng");
  const total = opts.pages.length;
  const results: OcrPageResult[] = [];
  let current = 0;
  const worker = await createWorker(langs, 1, {
    workerPath: "/vendor/tesseract/worker.min.js",
    corePath: "/vendor/tesseract/",
    langPath: local ? "/vendor/tessdata/" : undefined,
    gzip: true,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === "recognizing text") {
        opts.onProgress?.({
          page: current + 1,
          pages: total,
          pct: Math.round(((current + m.progress) / Math.max(1, total)) * 100),
          status: "Recognizing text",
        });
      }
    },
  });
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    void worker.terminate();
  };
  opts.signal?.addEventListener("abort", onAbort);
  try {
    for (let i = 0; i < total; i++) {
      if (opts.signal?.aborted) {
        cancelled = true;
        break;
      }
      current = i;
      const page = opts.pages[i];
      opts.onProgress?.({ page: i + 1, pages: total, pct: Math.round((i / total) * 100), status: "Rendering page" });
      const raw = await page.render();
      const prepared = opts.preprocess ? preprocessForOcr(raw, { deskew: true, denoise: true }) : { canvas: raw, skewDeg: 0 };
      const res = await worker.recognize(prepared.canvas, { rotateAuto: opts.rotateAuto }, { blocks: true, text: true });
      if (opts.signal?.aborted) {
        cancelled = true;
        break;
      }
      const data = res.data as unknown as { text: string; confidence: number };
      const sx = page.widthPt / prepared.canvas.width;
      const sy = page.heightPt / prepared.canvas.height;
      const words: OcrWord[] = collectWords(res.data).map((wd) => ({
        text: wd.text,
        x: wd.bbox.x0 * sx,
        y: wd.bbox.y0 * sy,
        w: Math.max(0.5, (wd.bbox.x1 - wd.bbox.x0) * sx),
        h: Math.max(1, (wd.bbox.y1 - wd.bbox.y0) * sy),
        conf: wd.conf,
      }));
      results.push({
        index: page.index,
        text: (data.text ?? "").trim(),
        confidence: Math.round(Number(data.confidence ?? 0)),
        widthPt: page.widthPt,
        heightPt: page.heightPt,
        words,
        lowConfidenceWords: words.filter((w) => w.conf < LOW_CONFIDENCE).length,
        skewDeg: Math.round(prepared.skewDeg * 10) / 10,
      });
      raw.width = 0;
      raw.height = 0;
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    if (!cancelled) await worker.terminate().catch(() => undefined);
  }
  opts.onProgress?.({ page: results.length, pages: total, pct: cancelled ? 0 : 100, status: cancelled ? "Cancelled" : "Complete" });
  return { results, cancelled };
}

/**
 * Searchable PDF: each page is the scanned image, with the recognized words placed invisibly
 * (opacity 0) at their measured positions so search, selection and copy work in any reader.
 */
export async function buildSearchablePdf(
  pages: { jpeg: Uint8Array; widthPt: number; heightPt: number; words: OcrWord[] }[],
): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const warnings = new Set<string>();
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font: PDFFont = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.addPage([p.widthPt, p.heightPt]);
    const img = await doc.embedJpg(p.jpeg);
    page.drawImage(img, { x: 0, y: 0, width: p.widthPt, height: p.heightPt });
    for (const w of p.words) {
      const size = Math.max(4, w.h * 0.9);
      const text = safeFontText(font, w.text, () => warnings.add("Some recognized characters are not in the standard PDF font and were replaced in the text layer."));
      if (!text.trim()) continue;
      const baseline = p.heightPt - w.y - w.h * 0.8;
      let fitted = text;
      // Scale the run to the measured word width so text selection boxes line up with the scan.
      const natural = font.widthOfTextAtSize(fitted, size);
      if (natural > w.w * 1.6 && fitted.length > 1) fitted = fitted.slice(0, Math.max(1, Math.floor(fitted.length * (w.w / natural))));
      page.drawText(fitted, { x: w.x, y: baseline, size, font, opacity: 0 });
    }
  }
  if (!pages.length) doc.addPage([595.28, 841.89]);
  return { bytes: new Uint8Array(await doc.save()), warnings: [...warnings] };
}

export { canvasToBytes };
