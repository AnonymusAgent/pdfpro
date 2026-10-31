/**
 * Other formats → PDF. DOCX (Mammoth), XLSX (ExcelJS), PPTX (OOXML text/shapes/pictures),
 * Markdown, HTML, plain text, PNG/JPEG/TIFF images. Legacy binary Office files (.doc/.xls/.ppt)
 * require LibreOffice and are rejected with an explanation rather than mis-converted.
 */
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from "@cantoo/pdf-lib";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import mammoth from "mammoth";
import { base64ToBytes } from "../browser";
import { safeFontText, wrapText } from "./export";
import { canvasToBytes } from "./pdfjs";
import { mammothInput } from "./validate";

export class UnsupportedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFormatError";
  }
}

export type Block2 =
  | { type: "h"; level: 1 | 2 | 3; text: string }
  | { type: "p"; text: string }
  | { type: "li"; text: string }
  | { type: "table"; rows: string[][] }
  | { type: "img"; bytes: Uint8Array; kind: "png" | "jpg" }
  | { type: "break" };

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 54;

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

const stripTags = (s: string) => decodeEntities(s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();

/** Turns Mammoth/HTML output into ordered blocks. Handles headings, paragraphs, lists, tables and inline images. */
export function htmlToBlocks(html: string): Block2[] {
  const blocks: Block2[] = [];
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  const pushImages = (content: string) => {
    for (const m of content.matchAll(/<img\b[^>]*src="data:image\/(png|jpe?g);base64,([^"]+)"/gi)) {
      blocks.push({ type: "img", bytes: base64ToBytes(m[2]), kind: /png/i.test(m[1]) ? "png" : "jpg" });
    }
  };
  const pattern = /<(table|h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>|<img\b[^>]*src="data:image\/(png|jpe?g);base64,([^"]+)"[^>]*\/?>/gi;
  for (const m of cleaned.matchAll(pattern)) {
    if (m[0].toLowerCase().startsWith("<img")) {
      blocks.push({ type: "img", bytes: base64ToBytes(m[5]), kind: /png/i.test(m[4]) ? "png" : "jpg" });
      continue;
    }
    const tag = m[1].toLowerCase();
    const content = m[2] ?? "";
    if (tag === "table") {
      const rows = [...content.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) =>
        [...r[0].matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((c) => stripTags(c[1])),
      );
      if (rows.length) blocks.push({ type: "table", rows });
      continue;
    }
    pushImages(content);
    const text = stripTags(content);
    if (!text) continue;
    if (tag.startsWith("h")) blocks.push({ type: "h", level: Math.min(3, Number(tag[1])) as 1 | 2 | 3, text });
    else if (tag === "li") blocks.push({ type: "li", text });
    else blocks.push({ type: "p", text });
  }
  return blocks;
}

export function markdownToBlocks(md: string): Block2[] {
  const blocks: Block2[] = [];
  let inCode = false;
  let table: string[][] = [];
  const flushTable = () => {
    if (table.length) blocks.push({ type: "table", rows: table });
    table = [];
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.trim().startsWith("```")) {
      inCode = !inCode;
      flushTable();
      continue;
    }
    if (inCode) {
      blocks.push({ type: "p", text: line });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|?\s*:?-{2,}/.test(line)) continue;
      table.push(line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
      continue;
    }
    flushTable();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) blocks.push({ type: "h", level: Math.min(3, h[1].length) as 1 | 2 | 3, text: h[2].replace(/[*_`]/g, "") });
    else if (/^\s*[-*+]\s+/.test(line)) blocks.push({ type: "li", text: line.replace(/^\s*[-*+]\s+/, "").replace(/[*_`]/g, "") });
    else if (!line.trim()) blocks.push({ type: "break" });
    else blocks.push({ type: "p", text: line.replace(/\*\*(.*?)\*\*/g, "$1").replace(/[*_`]/g, "") });
  }
  flushTable();
  return blocks;
}

export function textToBlocks(text: string): Block2[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((t) => t.replace(/\s+$/, ""))
    .filter((t) => t.trim().length > 0)
    .map((t) => ({ type: "p" as const, text: t }));
}

/** Lays out blocks on A4/Letter-like pages with wrapping, lists, bordered tables and images. */
class FlowWriter {
  readonly pages: PDFPage[] = [];
  private page!: PDFPage;
  private y = 0;
  constructor(
    private readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
    private readonly warn: (m: string) => void,
    private readonly width: number,
    private readonly height: number,
  ) {
    this.newPage();
  }

  private newPage() {
    this.page = this.doc.addPage([this.width, this.height]);
    this.pages.push(this.page);
    this.y = this.height - MARGIN;
  }

  private ensure(h: number) {
    if (this.y - h < MARGIN) this.newPage();
  }

  private clean(t: string, font: PDFFont) {
    return safeFontText(font, t, () => this.warn("Some characters are not available in the built-in PDF fonts and were replaced with '?'."));
  }

  text(raw: string, size: number, bold = false, indent = 0) {
    const font = bold ? this.bold : this.regular;
    const lines = wrapText(font, this.clean(raw, font), size, this.width - 2 * MARGIN - indent);
    for (const line of lines) {
      this.ensure(size * 1.35);
      if (line) this.page.drawText(line, { x: MARGIN + indent, y: this.y - size, size, font, color: rgb(0.08, 0.08, 0.1) });
      this.y -= size * 1.35;
    }
  }

  heading(text: string, level: 1 | 2 | 3) {
    const size = level === 1 ? 20 : level === 2 ? 16 : 13;
    this.y -= 6;
    this.text(text, size, true);
    this.y -= 4;
  }

  paragraph(text: string) {
    this.text(text, 11);
    this.y -= 6;
  }

  bullet(text: string) {
    this.text(`•  ${text}`, 11, false, 12);
  }

  table(rows: string[][]) {
    if (!rows.length) return;
    const cols = Math.max(...rows.map((r) => r.length));
    const usable = this.width - 2 * MARGIN;
    const natural = Array.from({ length: cols }, (_, c) =>
      Math.min(220, Math.max(36, ...rows.map((r) => this.regular.widthOfTextAtSize(this.clean(r[c] ?? "", this.regular), 9) + 10))),
    );
    const total = natural.reduce((a, b) => a + b, 0);
    const widths = natural.map((w) => (total > usable ? (w * usable) / total : w));
    rows.forEach((row, ri) => {
      const cells = widths.map((w, c) => wrapText(this.regular, this.clean(row[c] ?? "", this.regular), 9, Math.max(8, w - 8)));
      const lines = Math.max(1, ...cells.map((c) => c.length));
      const rowH = lines * 11 + 6;
      this.ensure(rowH);
      const header = ri === 0;
      const sum = widths.reduce((a, b) => a + b, 0);
      if (header) this.page.drawRectangle({ x: MARGIN, y: this.y - rowH, width: sum, height: rowH, color: rgb(0.92, 0.94, 0.97) });
      let x = MARGIN;
      widths.forEach((w, c) => {
        this.page.drawRectangle({ x, y: this.y - rowH, width: w, height: rowH, borderColor: rgb(0.7, 0.74, 0.8), borderWidth: 0.5 });
        cells[c].forEach((line, li) => {
          if (line) this.page.drawText(line, { x: x + 4, y: this.y - 10 - li * 11, size: 9, font: header ? this.bold : this.regular, color: rgb(0.08, 0.08, 0.1) });
        });
        x += w;
      });
      this.y -= rowH;
    });
    this.y -= 10;
  }

  image(img: PDFImage) {
    const maxW = this.width - 2 * MARGIN;
    const maxH = this.height - 2 * MARGIN;
    const scale = Math.min(1, maxW / img.width, maxH / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    this.ensure(h + 8);
    this.page.drawImage(img, { x: MARGIN, y: this.y - h, width: w, height: h });
    this.y -= h + 10;
  }
}

async function renderBlocks(
  blocks: Block2[],
  opts: { width?: number; height?: number; warnings: Set<string>; doc?: PDFDocument },
): Promise<Uint8Array> {
  const doc = opts.doc ?? (await PDFDocument.create({ updateMetadata: false }));
  const regular = await doc.embedFont("Helvetica");
  const bold = await doc.embedFont("Helvetica-Bold");
  const writer = new FlowWriter(doc, regular, bold, (m) => opts.warnings.add(m), opts.width ?? PAGE_W, opts.height ?? PAGE_H);
  for (const b of blocks) {
    switch (b.type) {
      case "h":
        writer.heading(b.text, b.level);
        break;
      case "p":
        writer.paragraph(b.text);
        break;
      case "li":
        writer.bullet(b.text);
        break;
      case "table":
        writer.table(b.rows);
        break;
      case "img": {
        const img = b.kind === "png" ? await doc.embedPng(b.bytes) : await doc.embedJpg(b.bytes);
        writer.image(img);
        break;
      }
      case "break":
        writer.paragraph("");
        break;
    }
  }
  if (!writer.pages.length) doc.addPage([PAGE_W, PAGE_H]);
  return new Uint8Array(await doc.save());
}

export async function docxToBlocks(bytes: Uint8Array, warnings: Set<string>): Promise<Block2[]> {
  const result = await mammoth.convertToHtml(
    mammothInput(bytes),
    {
      convertImage: mammoth.images.imgElement(async (image) => ({
        src: `data:${image.contentType};base64,${await image.read("base64")}`,
      })),
    },
  );
  for (const m of result.messages) if (m.type === "warning") warnings.add(`DOCX: ${m.message}`);
  return htmlToBlocks(result.value);
}

export async function xlsxToBlocks(bytes: Uint8Array, warnings: Set<string>): Promise<Block2[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes.slice().buffer as ArrayBuffer);
  const blocks: Block2[] = [];
  wb.eachSheet((ws) => {
    blocks.push({ type: "h", level: 2, text: ws.name });
    const rows: string[][] = [];
    let truncated = false;
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= 2000) {
        truncated = true;
        return;
      }
      const values: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        values[col - 1] = cell.text ?? "";
      });
      rows.push(Array.from({ length: values.length }, (_, i) => values[i] ?? ""));
    });
    if (truncated) warnings.add(`Sheet "${ws.name}" was limited to its first 2000 rows in PDF output.`);
    if (rows.length) blocks.push({ type: "table", rows });
    else blocks.push({ type: "p", text: "(empty sheet)" });
  });
  return blocks;
}

const xmlDecode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

/** PPTX → PDF: one page per slide at the slide's real size; text boxes, pictures and tables placed by their coordinates. */
export async function pptxToPdf(bytes: Uint8Array, warnings: Set<string>): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes.slice().buffer as ArrayBuffer);
  const presentation = await zip.file("ppt/presentation.xml")?.async("string");
  if (!presentation) throw new Error("The PPTX file has no presentation part.");
  const size = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(presentation);
  const EMU = 12700;
  const slideW = size ? Number(size[1]) / EMU : 960;
  const slideH = size ? Number(size[2]) / EMU : 540;
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  if (!slideNames.length) throw new Error("The PPTX file contains no slides.");

  const doc = await PDFDocument.create({ updateMetadata: false });
  const regular = await doc.embedFont("Helvetica");
  const boldFont = await doc.embedFont("Helvetica-Bold");

  for (const name of slideNames) {
    const xml = await zip.file(name)!.async("string");
    const relsXml = (await zip.file(name.replace("slides/", "slides/_rels/") + ".rels")?.async("string")) ?? "";
    const rels = new Map<string, string>();
    for (const m of relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      rels.set(m[1], m[2].replace(/^\.\.\//, "ppt/"));
    }
    const page = doc.addPage([slideW, slideH]);
    const shapeRe = /<p:(sp|pic|graphicFrame)\b[\s\S]*?<\/p:\1>/g;
    for (const shape of xml.matchAll(shapeRe)) {
      const s = shape[0];
      const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(s) ?? /<p:xfrm[^>]*>\s*<a:off x="(-?\d+)" y="(-?\d+)"/.exec(s);
      const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(s);
      const x = off ? Number(off[1]) / EMU : 0;
      const top = off ? Number(off[2]) / EMU : 0;
      const w = ext ? Number(ext[1]) / EMU : slideW - x;
      const h = ext ? Number(ext[2]) / EMU : 40;
      if (shape[1] === "pic") {
        const embed = /r:embed="([^"]+)"/.exec(s)?.[1];
        const target = embed ? rels.get(embed) : undefined;
        const file = target ? zip.file(target) : null;
        if (!file) continue;
        const data = await file.async("uint8array");
        const isPng = data[0] === 0x89 && data[1] === 0x50;
        const isJpg = data[0] === 0xff && data[1] === 0xd8;
        if (!isPng && !isJpg) {
          warnings.add("Some slide images use a format that cannot be embedded (only PNG and JPEG are supported).");
          continue;
        }
        const img = isPng ? await doc.embedPng(data) : await doc.embedJpg(data);
        page.drawImage(img, { x, y: slideH - top - h, width: w, height: h });
        continue;
      }
      if (shape[1] === "graphicFrame" && !s.includes("<a:tbl>")) {
        if (/<c:chart|<dgm:/.test(s)) warnings.add("Charts and SmartArt diagrams are not converted; only text, pictures and tables are.");
        continue;
      }
      // Paragraphs of text or table rows.
      const paragraphs: { text: string; size: number; bold: boolean }[] = [];
      if (s.includes("<a:tbl>")) {
        for (const row of s.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)) {
          const cells = [...row[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((c) =>
            [...c[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => xmlDecode(t[1])).join(""),
          );
          paragraphs.push({ text: cells.join("   |   "), size: 11, bold: false });
        }
      } else {
        for (const p of s.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
          const sz = /<a:rPr[^>]*\bsz="(\d+)"/.exec(p[1]);
          const bold = /<a:rPr[^>]*\bb="1"/.test(p[1]);
          const text = [...p[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => xmlDecode(t[1])).join("");
          if (text.trim()) paragraphs.push({ text, size: sz ? Number(sz[1]) / 100 : 18, bold });
        }
      }
      let cursor = slideH - top - 4;
      for (const para of paragraphs) {
        const font = para.bold ? boldFont : regular;
        const size = Math.min(40, Math.max(6, para.size));
        const clean = safeFontText(font, para.text, () => warnings.add("Some characters are not available in the built-in PDF fonts and were replaced with '?'."));
        for (const line of wrapText(font, clean, size, Math.max(10, w - 6))) {
          cursor -= size * 1.2;
          if (cursor < 0) break;
          if (line) page.drawText(line, { x: x + 3, y: cursor, size, font, color: rgb(0.08, 0.08, 0.1) });
        }
      }
    }
  }
  return new Uint8Array(await doc.save());
}

async function tiffToPng(bytes: Uint8Array): Promise<{ png: Uint8Array; w: number; h: number }> {
  const UTIF = (await import("utif")).default;
  const buf = bytes.slice().buffer as ArrayBuffer;
  const ifds = UTIF.decode(buf);
  if (!ifds.length) throw new Error("The TIFF file contains no images.");
  UTIF.decodeImage(buf, ifds[0], ifds);
  const rgba = UTIF.toRGBA8(ifds[0]);
  const w = ifds[0].width;
  const h = ifds[0].height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable for TIFF decoding.");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), w, h), 0, 0);
  return { png: await canvasToBytes(canvas, "image/png"), w, h };
}

/** Images → PDF. fit: place each image on an A4 page with margins. native: page size = image size. */
export async function imagesToPdf(
  files: { name: string; bytes: Uint8Array }[],
  fit: boolean,
  warnings: Set<string>,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const f of files) {
    const head = f.bytes;
    let bytes = f.bytes;
    let kind: "png" | "jpg";
    let w = 0;
    let h = 0;
    if (head[0] === 0x89 && head[1] === 0x50) kind = "png";
    else if (head[0] === 0xff && head[1] === 0xd8) kind = "jpg";
    else if ((head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4d && head[1] === 0x4d)) {
      const t = await tiffToPng(head);
      bytes = t.png;
      kind = "png";
      w = t.w;
      h = t.h;
    } else throw new UnsupportedFormatError(`"${f.name}" is not a PNG, JPEG or TIFF image.`);
    const img = kind === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    if (!w) {
      w = img.width;
      h = img.height;
    }
    if (fit) {
      const page = doc.addPage([PAGE_W, PAGE_H]);
      const scale = Math.min((PAGE_W - 2 * MARGIN) / w, (PAGE_H - 2 * MARGIN) / h, 1);
      const dw = w * scale;
      const dh = h * scale;
      page.drawImage(img, { x: (PAGE_W - dw) / 2, y: (PAGE_H - dh) / 2, width: dw, height: dh });
    } else {
      const page = doc.addPage([w, h]);
      page.drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
  }
  if (!files.length) warnings.add("No images were provided.");
  return new Uint8Array(await doc.save());
}

const LEGACY = new Set(["doc", "xls", "ppt"]);

/**
 * Converts one input file to PDF bytes. Throws UnsupportedFormatError for unsupported inputs.
 * Multiple files are converted individually by the caller and combined with mergeDocuments.
 */
export async function fileToPdf(file: { name: string; bytes: Uint8Array }): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const warnings = new Set<string>();
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const text = () => new TextDecoder("utf-8", { fatal: false }).decode(file.bytes);
  if (LEGACY.has(ext)) {
    throw new UnsupportedFormatError(
      `Legacy .${ext} files need the LibreOffice conversion service, which is not configured in this build. Save the file as .${ext}x and try again.`,
    );
  }
  let bytes: Uint8Array;
  switch (ext) {
    case "docx":
      bytes = await renderBlocks(await docxToBlocks(file.bytes, warnings), { warnings });
      break;
    case "xlsx":
      bytes = await renderBlocks(await xlsxToBlocks(file.bytes, warnings), { warnings, width: 842, height: 595 });
      break;
    case "pptx":
      bytes = await pptxToPdf(file.bytes, warnings);
      break;
    case "md":
    case "markdown":
      bytes = await renderBlocks(markdownToBlocks(text()), { warnings });
      break;
    case "html":
    case "htm":
      bytes = await renderBlocks(htmlToBlocks(text()), { warnings });
      break;
    case "txt":
    case "csv":
      bytes = await renderBlocks(textToBlocks(text()), { warnings });
      break;
    case "png":
    case "jpg":
    case "jpeg":
    case "tif":
    case "tiff":
      bytes = await imagesToPdf([file], true, warnings);
      break;
    case "pdf":
      bytes = file.bytes;
      break;
    default:
      throw new UnsupportedFormatError(`Files of type ".${ext || "unknown"}" cannot be converted to PDF.`);
  }
  return { bytes, warnings: [...warnings] };
}

