/**
 * PDF export engine: builds a new PDF from source documents plus the editor state.
 * Pure pdf-lib (no DOM) so the same code runs in the browser and in Node tests.
 *
 * Guarantees
 * - Annotations are stored in page space and drawn in the page's final orientation, so they
 *   stay attached to page content after rotation, reordering and paper-size changes.
 * - Secure redaction replaces redacted pages with raster images (no text layer). Pages
 *   without redaction keep their text.
 * - Characters the built-in fonts cannot encode are reported as warnings, never dropped silently.
 * - Text that does not fit its box is reported as a warning, not silently clipped.
 */
import { PDFDocument, PDFDict, PDFName, PDFString, LineCapStyle, StandardFonts, degrees, rgb } from "@cantoo/pdf-lib";
import type { PDFFont, PDFImage, PDFPage, PDFTextField } from "@cantoo/pdf-lib";
import { base64ToBytes } from "../browser";
import { normRot } from "./geometry";
import { PAPER_SIZES, type Ann, type Box, type EditState, type FontFamily } from "./types";

type RGBColor = ReturnType<typeof rgb>;

export type RasterPage = { bytes: Uint8Array; W: number; H: number };

export type EncryptOptions = {
  ownerPassword: string;
  userPassword?: string;
  permissions: {
    printing: boolean;
    copying: boolean;
    modifying: boolean;
    annotating: boolean;
    fillingForms: boolean;
  };
};

export type DecorationOptions = {
  watermark?: { text: string; opacity?: number; color?: string } | null;
  headerText?: string;
  footerText?: string;
  pageNumbers?: boolean;
  batesPrefix?: string;
};

export type ExportOptions = DecorationOptions & {
  paperSize?: "original" | keyof typeof PAPER_SIZES;
  landscape?: boolean;
  marginPt?: number;
  background?: string | null;
  metadata?: { title?: string; author?: string; subject?: string; keywords?: string };
  sanitizeMetadata?: boolean;
  encrypt?: EncryptOptions | null;
};

export type ExportInput = {
  sources: Record<string, Uint8Array>;
  edit: EditState;
  rasters?: Record<string, RasterPage>;
  options?: ExportOptions;
};

export type ExportResult = { bytes: Uint8Array; pageCount: number; warnings: string[] };

/** Geometry of one output page: maps normalized page space (u,v) to PDF user space. */
type Geo = { a: number; b: number; s: number; x0: number; y0: number; W0: number; H0: number };

type FontCache = { doc: PDFDocument; fonts: Map<string, PDFFont>; ok: Map<string, boolean> };

type Ctx = {
  cache: FontCache;
  images: Map<string, PDFImage>;
  warnings: Set<string>;
  formUsed: boolean;
};

const STANDARD: Record<FontFamily, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

const UNENCODABLE_WARNING = "Some characters are not available in the built-in PDF fonts and were replaced with '?'.";
const OVERFLOW_WARNING = "Some text did not fit inside its box and was cut off. Enlarge the box or reduce the font size.";

export function hexColor(c: string | null | undefined): RGBColor | undefined {
  if (!c) return undefined;
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));

/** Page ids that contain at least one redaction mark. */
export function redactedUids(edit: EditState): string[] {
  return [...new Set(edit.anns.filter((a) => a.type === "redact").map((a) => a.uid))];
}

async function standardFont(cache: FontCache, family: FontFamily = "helvetica", bold = false, italic = false) {
  const key = `${family}-${bold ? "b" : ""}${italic ? "i" : ""}`;
  let font = cache.fonts.get(key);
  if (!font) {
    const idx = (bold ? 1 : 0) + (italic ? 2 : 0);
    font = await cache.doc.embedFont(STANDARD[family][idx]);
    cache.fonts.set(key, font);
  }
  return { font, key };
}

const CP1252_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".split(""));

/**
 * True when a code point is representable by the standard PDF fonts (WinAnsi / CP1252).
 * Checked explicitly: the font encoder does not reliably throw for other characters.
 */
export function winAnsiOk(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  if (c >= 0x20 && c <= 0x7e) return true;
  if (c >= 0xa0 && c <= 0xff) return true;
  return CP1252_EXTRA.has(ch);
}

/** Replaces characters the standard font cannot encode, and normalizes control characters. */
function safeText(cache: FontCache, key: string, font: PDFFont, text: string, onReplace: () => void): string {
  let out = "";
  for (const ch of text) {
    if (ch === "\n" || ch === "\r") {
      out += "\n";
      continue;
    }
    if (ch === "\t") {
      out += "    ";
      continue;
    }
    if (ch.charCodeAt(0) < 32) continue;
    const k = `${key}|${ch}`;
    let ok = cache.ok.get(k);
    if (ok === undefined) {
      ok = winAnsiOk(ch);
      cache.ok.set(k, ok);
    }
    if (ok) out += ch;
    else {
      out += "?";
      onReplace();
    }
  }
  return out;
}

/** Font-only wrapper for other modules: replaces unencodable characters (no shared cache). */
export function safeFontText(font: PDFFont, text: string, onReplace: () => void): string {
  return safeText({ doc: undefined as unknown as PDFDocument, fonts: new Map(), ok: new Map() }, "adhoc", font, text, onReplace);
}

/** Word-wraps (and hard-breaks very long words) so every line fits maxWidth. */
export function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const cand = line ? `${line} ${word}` : word;
      if (!line || font.widthOfTextAtSize(cand, size) <= maxWidth) {
        line = cand;
      } else {
        lines.push(line);
        line = word;
      }
      while (line.length > 1 && font.widthOfTextAtSize(line, size) > maxWidth) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

const px = (g: Geo, u: number) => g.a + g.s * (g.x0 + u * g.W0);
const py = (g: Geo, v: number) => g.b + g.s * (g.y0 + (1 - v) * g.H0);
const pwid = (g: Geo, w: number) => w * g.W0 * g.s;
const phei = (g: Geo, h: number) => h * g.H0 * g.s;

async function embedImage(ctx: Ctx, dataUrl: string): Promise<PDFImage> {
  const cached = ctx.images.get(dataUrl);
  if (cached) return cached;
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!m) throw new Error("Image data is not a PNG or JPEG data URL.");
  const bytes = base64ToBytes(m[2].replace(/\s/g, ""));
  const img = /png/i.test(m[1]) ? await ctx.cache.doc.embedPng(bytes) : await ctx.cache.doc.embedJpg(bytes);
  ctx.images.set(dataUrl, img);
  return img;
}

function addLinkAnnotation(doc: PDFDocument, page: PDFPage, url: string, rect: number[]) {
  const annot = doc.context.obj({}) as PDFDict;
  const action = doc.context.obj({}) as PDFDict;
  action.set(PDFName.of("S"), PDFName.of("URI"));
  action.set(PDFName.of("URI"), PDFString.of(url));
  annot.set(PDFName.of("Type"), PDFName.of("Annot"));
  annot.set(PDFName.of("Subtype"), PDFName.of("Link"));
  annot.set(PDFName.of("Rect"), doc.context.obj(rect));
  annot.set(PDFName.of("Border"), doc.context.obj([0, 0, 0]));
  annot.set(PDFName.of("A"), action);
  page.node.addAnnot(doc.context.register(annot));
}

type Box2 = { L: number; B: number; W: number; H: number };

async function drawTextInBox(
  ctx: Ctx,
  page: PDFPage,
  text: string,
  box: Box2,
  a: Ann,
  g: Geo,
  color: RGBColor,
  family: FontFamily,
  bold: boolean,
  italic: boolean,
  align: "left" | "center" | "right",
) {
  const { font, key } = await standardFont(ctx.cache, family, bold, italic);
  const size = Math.max(4, a.fontSize * g.s);
  const pad = 3 * g.s;
  const clean = safeText(ctx.cache, key, font, text, () => ctx.warnings.add(UNENCODABLE_WARNING));
  const lines = wrapText(font, clean, size, Math.max(1, box.W - 2 * pad));
  const lineH = size * 1.2;
  let y = box.B + box.H - pad - size * 0.82;
  for (const line of lines) {
    if (y < box.B - size * 0.2) {
      ctx.warnings.add(OVERFLOW_WARNING);
      break;
    }
    const lw = font.widthOfTextAtSize(line, size);
    const x = align === "center" ? box.L + (box.W - lw) / 2 : align === "right" ? box.L + box.W - pad - lw : box.L + pad;
    if (line) page.drawText(line, { x, y, size, font, color, opacity: clamp01(a.opacity) });
    y -= lineH;
  }
}

async function drawAnn(ctx: Ctx, page: PDFPage, a: Ann, g: Geo, rasterized: boolean): Promise<void> {
  const L = px(g, a.x);
  const B = py(g, a.y + a.h);
  const W = pwid(g, a.w);
  const H = phei(g, a.h);
  const color = hexColor(a.color) ?? rgb(0, 0, 0);
  const fill = hexColor(a.fill ?? undefined);
  const op = clamp01(a.opacity);
  const stroke = Math.max(0.25, (a.strokeWidth ?? 1.5) * g.s);
  const box: Box2 = { L, B, W, H };
  const align = a.align ?? "left";

  switch (a.type) {
    case "highlight":
      page.drawRectangle({ x: L, y: B, width: W, height: H, color: hexColor(a.color) ?? rgb(1, 0.92, 0.23), opacity: op, borderWidth: 0 });
      break;
    case "underline":
      page.drawLine({ start: { x: L, y: B + stroke }, end: { x: L + W, y: B + stroke }, thickness: stroke, color, opacity: op });
      break;
    case "strike":
      page.drawLine({ start: { x: L, y: B + H / 2 }, end: { x: L + W, y: B + H / 2 }, thickness: stroke, color, opacity: op });
      break;
    case "rect":
      page.drawRectangle({ x: L, y: B, width: W, height: H, borderColor: color, borderWidth: stroke, color: fill, opacity: op, borderOpacity: op });
      break;
    case "ellipse":
      page.drawEllipse({ x: L + W / 2, y: B + H / 2, xScale: W / 2, yScale: H / 2, borderColor: color, borderWidth: stroke, color: fill, opacity: op, borderOpacity: op });
      break;
    case "line":
    case "arrow": {
      const pts = a.points && a.points.length >= 2 ? a.points : [{ x: a.x, y: a.y }, { x: a.x + a.w, y: a.y + a.h }];
      const s = { x: px(g, pts[0].x), y: py(g, pts[0].y) };
      const e = { x: px(g, pts[1].x), y: py(g, pts[1].y) };
      page.drawLine({ start: s, end: e, thickness: stroke, color, opacity: op });
      if (a.type === "arrow") {
        const ang = Math.atan2(e.y - s.y, e.x - s.x);
        const len = Math.max(8, 4 * stroke);
        for (const d of [0.84 * Math.PI, -0.84 * Math.PI]) {
          page.drawLine({ start: e, end: { x: e.x + len * Math.cos(ang + d), y: e.y + len * Math.sin(ang + d) }, thickness: stroke, color, opacity: op });
        }
      }
      break;
    }
    case "draw": {
      const pts = a.points ?? [];
      for (let i = 1; i < pts.length; i++) {
        page.drawLine({
          start: { x: px(g, pts[i - 1].x), y: py(g, pts[i - 1].y) },
          end: { x: px(g, pts[i].x), y: py(g, pts[i].y) },
          thickness: stroke,
          color,
          opacity: op,
          lineCap: LineCapStyle.Round,
        });
      }
      break;
    }
    case "whiteout":
      page.drawRectangle({ x: L, y: B, width: W, height: H, color: rgb(1, 1, 1), borderWidth: 0 });
      break;
    case "redact":
      // Secure redaction already removed the content from rasterized pages; otherwise this is a visual cover only.
      if (!rasterized) page.drawRectangle({ x: L, y: B, width: W, height: H, color: rgb(0, 0, 0), borderWidth: 0, opacity: 1 });
      break;
    case "replace":
      page.drawRectangle({ x: L, y: B, width: W, height: H, color: rgb(1, 1, 1), borderWidth: 0 });
      await drawTextInBox(ctx, page, a.text ?? "", box, a, g, color, a.font ?? "helvetica", !!a.bold, !!a.italic, align);
      break;
    case "text":
      if (fill) page.drawRectangle({ x: L, y: B, width: W, height: H, color: fill, borderWidth: 0 });
      await drawTextInBox(ctx, page, a.text ?? "", box, a, g, color, a.font ?? "helvetica", !!a.bold, !!a.italic, align);
      break;
    case "note":
      page.drawRectangle({
        x: L,
        y: B,
        width: W,
        height: H,
        color: fill ?? rgb(1, 0.95, 0.6),
        borderColor: rgb(0.75, 0.62, 0.1),
        borderWidth: 0.75 * g.s,
        opacity: 0.97,
      });
      await drawTextInBox(ctx, page, a.text ?? "", box, a, g, color, "helvetica", false, false, "left");
      break;
    case "stamp":
      page.drawRectangle({ x: L, y: B, width: W, height: H, borderColor: color, borderWidth: 2 * g.s, color: fill, opacity: op, borderOpacity: op });
      await drawTextInBox(ctx, page, (a.text ?? "").toUpperCase(), box, a, g, color, "helvetica", true, false, "center");
      break;
    case "field": {
      const name = a.fieldName ?? `field_${a.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}`;
      const form = ctx.cache.doc.getForm();
      let field: PDFTextField;
      try {
        field = form.createTextField(name);
      } catch {
        field = form.getTextField(name);
      }
      field.setText(a.text ?? "");
      field.addToPage(page, {
        x: L,
        y: B,
        width: W,
        height: H,
        borderColor: rgb(0.15, 0.35, 0.9),
        backgroundColor: rgb(0.93, 0.96, 1),
        textColor: color,
      });
      ctx.formUsed = true;
      break;
    }
    case "link": {
      const url = a.url ?? "";
      if (!/^(https?:|mailto:)/i.test(url)) {
        ctx.warnings.add("A link without a valid http(s) or mailto address was skipped.");
        break;
      }
      addLinkAnnotation(ctx.cache.doc, page, url, [L, B, L + W, B + H]);
      break;
    }
    case "image":
    case "signature": {
      if (!a.dataUrl) break;
      const img = await embedImage(ctx, a.dataUrl);
      const rot = ((Math.round(a.rotation ?? 0) % 360) + 360) % 360;
      if (rot === 0) {
        page.drawImage(img, { x: L, y: B, width: W, height: H, opacity: op });
      } else {
        // pdf-lib rotates around the bottom-left corner; solve for the origin that keeps the centre fixed.
        const th = (-rot * Math.PI) / 180;
        const cx = L + W / 2;
        const cy = B + H / 2;
        const vx = (W / 2) * Math.cos(th) - (H / 2) * Math.sin(th);
        const vy = (W / 2) * Math.sin(th) + (H / 2) * Math.cos(th);
        page.drawImage(img, { x: cx - vx, y: cy - vy, width: W, height: H, rotate: degrees(-rot), opacity: op });
      }
      break;
    }
    default:
      break;
  }
}

/** Watermark, header, footer, page numbers and Bates numbers. Works in place on any PDFDocument. */
export async function applyDecorations(
  doc: PDFDocument,
  pages: PDFPage[],
  o: DecorationOptions,
  warnings: Set<string>,
  cache?: FontCache,
): Promise<void> {
  if (!o.watermark?.text && !o.headerText && !o.footerText && !o.pageNumbers && !o.batesPrefix) return;
  const fc: FontCache = cache ?? { doc, fonts: new Map(), ok: new Map() };
  const regular = await standardFont(fc, "helvetica");
  const bold = await standardFont(fc, "helvetica", true);
  const clean = (f: { font: PDFFont; key: string }, t: string) =>
    safeText(fc, f.key, f.font, t, () => warnings.add(UNENCODABLE_WARNING));
  const n = pages.length;
  pages.forEach((page, i) => {
    const W = page.getWidth();
    const H = page.getHeight();
    if (o.watermark?.text) {
      const t = clean(bold, o.watermark.text);
      const size = Math.min(72, Math.max(18, Math.min(W, H) / 10));
      const tw = bold.font.widthOfTextAtSize(t, size);
      const th = (45 * Math.PI) / 180;
      const vx = (tw / 2) * Math.cos(th) - (size / 3) * Math.sin(th);
      const vy = (tw / 2) * Math.sin(th) + (size / 3) * Math.cos(th);
      page.drawText(t, {
        x: W / 2 - vx,
        y: H / 2 - vy,
        size,
        font: bold.font,
        color: hexColor(o.watermark.color) ?? rgb(0.55, 0.6, 0.7),
        opacity: o.watermark.opacity ?? 0.18,
        rotate: degrees(45),
      });
    }
    const centered = (t: string, y: number, size: number) => {
      const s = clean(regular, t);
      page.drawText(s, { x: (W - regular.font.widthOfTextAtSize(s, size)) / 2, y, size, font: regular.font, color: rgb(0.35, 0.4, 0.5) });
    };
    if (o.headerText) centered(o.headerText, H - 22, 9);
    if (o.footerText) centered(o.footerText, 14, 9);
    if (o.pageNumbers) centered(`${i + 1} / ${n}`, 28, 9);
    if (o.batesPrefix) {
      const s = clean(regular, `${o.batesPrefix}${String(i + 1).padStart(6, "0")}`);
      page.drawText(s, { x: W - 30 - regular.font.widthOfTextAtSize(s, 8), y: 14, size: 8, font: regular.font, color: rgb(0.2, 0.2, 0.2) });
    }
  });
}

function orient(base: [number, number], landscape: boolean | undefined, rotated: boolean): [number, number] {
  const display: [number, number] = landscape ? [base[1], base[0]] : [base[0], base[1]];
  return rotated ? [display[1], display[0]] : display;
}

function applyEncryption(doc: PDFDocument, e: EncryptOptions) {
  doc.encrypt({
    userPassword: e.userPassword ?? "",
    ownerPassword: e.ownerPassword,
    permissions: {
      printing: e.permissions.printing ? "highResolution" : false,
      copying: e.permissions.copying,
      modifying: e.permissions.modifying,
      annotating: e.permissions.annotating,
      fillingForms: e.permissions.fillingForms,
      contentAccessibility: true,
      documentAssembly: e.permissions.modifying,
    },
  });
}

/** Builds the output PDF for the given editor state. */
export async function buildEditedPdf(input: ExportInput): Promise<ExportResult> {
  const opts = input.options ?? {};
  const out = await PDFDocument.create({ updateMetadata: false });
  const ctx: Ctx = {
    cache: { doc: out, fonts: new Map(), ok: new Map() },
    images: new Map(),
    warnings: new Set(),
    formUsed: false,
  };
  const sources = new Map<string, PDFDocument>();
  const loadSource = async (id: string): Promise<PDFDocument> => {
    const cached = sources.get(id);
    if (cached) return cached;
    const bytes = input.sources[id];
    if (!bytes) throw new Error(`The source document for this page is missing ("${id}"). Re-open the file and try again.`);
    let doc: PDFDocument;
    try {
      doc = await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (e) {
      throw new Error(
        `A source PDF could not be read (${(e as Error).message}). If it is password-protected, remove the password first in Sign & Secure.`,
      );
    }
    sources.set(id, doc);
    return doc;
  };

  const paperBase = opts.paperSize && opts.paperSize !== "original" ? PAPER_SIZES[opts.paperSize] : null;
  const pagesOut: PDFPage[] = [];

  for (const entry of input.edit.pages) {
    const anns = input.edit.anns.filter((a) => a.uid === entry.uid);
    const raster = input.rasters?.[entry.uid];
    let page: PDFPage;
    let geo: Geo;
    let rasterized = false;
    let resized = false;

    if (entry.src === "blank") {
      const bw = entry.blankW ?? 595.28;
      const bh = entry.blankH ?? 841.89;
      const [pw, ph] = paperBase ? orient(paperBase, opts.landscape, false) : [bw, bh];
      page = out.addPage([pw, ph]);
      geo = { a: 0, b: 0, s: 1, x0: 0, y0: 0, W0: pw, H0: ph };
    } else {
      const src = await loadSource(entry.src);
      const srcPage = src.getPages()[entry.index];
      if (!srcPage) throw new Error(`Page ${entry.index + 1} does not exist in the source "${entry.src}".`);
      const view = srcPage.getCropBox();
      const x0 = view.x;
      const y0 = view.y;
      const W0 = view.width;
      const H0 = view.height;
      const total = normRot(srcPage.getRotation().angle + entry.rot);

      if (raster) {
        page = out.addPage([W0, H0]);
        page.drawImage(await out.embedJpg(raster.bytes), { x: 0, y: 0, width: W0, height: H0 });
        page.setRotation(degrees(total));
        geo = { a: -x0, b: -y0, s: 1, x0, y0, W0, H0 };
        rasterized = true;
      } else if (paperBase) {
        const R = entry.crop
          ? {
              x0: x0 + entry.crop.x * W0,
              y0: y0 + (1 - entry.crop.y - entry.crop.h) * H0,
              W: entry.crop.w * W0,
              H: entry.crop.h * H0,
            }
          : { x0, y0, W: W0, H: H0 };
        const [PW, PH] = orient(paperBase, opts.landscape, total % 180 !== 0);
        page = out.addPage([PW, PH]);
        page.setRotation(degrees(total));
        resized = true;
        const m = opts.marginPt ?? 0;
        const s = Math.min((PW - 2 * m) / R.W, (PH - 2 * m) / R.H);
        const ox = (PW - R.W * s) / 2;
        const oy = (PH - R.H * s) / 2;
        const bg = hexColor(opts.background ?? undefined);
        if (bg) page.drawRectangle({ x: 0, y: 0, width: PW, height: PH, color: bg });
        const embedded = await out.embedPage(srcPage, { left: R.x0, bottom: R.y0, right: R.x0 + R.W, top: R.y0 + R.H });
        page.drawPage(embedded, { x: ox, y: oy, xScale: s, yScale: s });
        geo = { a: ox - s * R.x0, b: oy - s * R.y0, s, x0, y0, W0, H0 };
      } else {
        const [copied] = await out.copyPages(src, [entry.index]);
        page = out.addPage(copied);
        page.setRotation(degrees(total));
        geo = { a: 0, b: 0, s: 1, x0, y0, W0, H0 };
      }
    }

    for (const a of anns) await drawAnn(ctx, page, a, geo, rasterized);

    if (entry.crop && !resized) {
      const c = entry.crop;
      const originX = rasterized ? 0 : geo.x0;
      const originY = rasterized ? 0 : geo.y0;
      page.setCropBox(originX + c.x * geo.W0, originY + (1 - c.y - c.h) * geo.H0, c.w * geo.W0, c.h * geo.H0);
    }
    pagesOut.push(page);
  }

  await applyDecorations(out, pagesOut, opts, ctx.warnings, ctx.cache);

  const m = opts.metadata ?? {};
  if (m.title) out.setTitle(m.title);
  if (m.author) out.setAuthor(m.author);
  if (m.subject) out.setSubject(m.subject);
  if (m.keywords) out.setKeywords(m.keywords.split(",").map((k) => k.trim()).filter(Boolean));
  out.setProducer("PDF Pro");
  out.setCreator(opts.sanitizeMetadata ? "" : "PDF Pro");

  if (ctx.formUsed) {
    const { font } = await standardFont(ctx.cache, "helvetica");
    out.getForm().updateFieldAppearances(font);
  }
  if (opts.encrypt) applyEncryption(out, opts.encrypt);

  const bytes = await out.save({ useObjectStreams: !opts.encrypt });
  return { bytes: new Uint8Array(bytes), pageCount: out.getPageCount(), warnings: [...ctx.warnings] };
}
