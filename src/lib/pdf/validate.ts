/**
 * Output validation. Every exported file is checked against its format's signature and
 * then opened with a real parser before it is offered for download.
 */
import { PDFDocument } from "@cantoo/pdf-lib";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import mammoth from "mammoth";
import { hasPdfHeader } from "./pdfjs";

export type OutputKind =
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "odt"
  | "epub"
  | "png"
  | "jpeg"
  | "tiff"
  | "svg"
  | "txt"
  | "md"
  | "html"
  | "csv"
  | "rtf"
  | "zip";

export const MIME_TYPES: Record<OutputKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  epub: "application/epub+zip",
  png: "image/png",
  jpeg: "image/jpeg",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  csv: "text/csv",
  rtf: "application/rtf",
  zip: "application/zip",
};

export const EXTENSIONS: Record<OutputKind, string> = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  odt: "odt",
  epub: "epub",
  png: "png",
  jpeg: "jpg",
  tiff: "tif",
  svg: "svg",
  txt: "txt",
  md: "md",
  html: "html",
  csv: "csv",
  rtf: "rtf",
  zip: "zip",
};

export type VerifyResult = { ok: true; detail: string } | { ok: false; error: string };

const pass = (detail: string): VerifyResult => ({ ok: true, detail });
const fail = (error: string): VerifyResult => ({ ok: false, error });

/** Copies bytes into a standalone ArrayBuffer for parsers that require one. */
const buf = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;

/** Mammoth reads a Node Buffer on the server and an ArrayBuffer in the browser. */
export function mammothInput(bytes: Uint8Array): { buffer: Buffer } | { arrayBuffer: ArrayBuffer } {
  if (typeof window === "undefined") return { buffer: Buffer.from(bytes) };
  return { arrayBuffer: bytes.slice().buffer as ArrayBuffer };
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  return sig.every((v, i) => bytes[i] === v);
}

export function sniffKind(bytes: Uint8Array): string {
  if (hasPdfHeader(bytes)) return "pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  return "unknown";
}

function isText(bytes: Uint8Array): boolean {
  for (let i = 0; i < Math.min(bytes.length, 4096); i++) if (bytes[i] === 0) return false;
  return true;
}

/** Opens the output with a parser appropriate to its format. Never trust extensions alone. */
export async function verifyOutput(kind: OutputKind, bytes: Uint8Array): Promise<VerifyResult> {
  if (!bytes || bytes.byteLength === 0) return fail("The output file is empty.");
  try {
    switch (kind) {
      case "pdf": {
        if (!hasPdfHeader(bytes)) return fail("The output does not start with a PDF header.");
        const doc = await PDFDocument.load(bytes, { updateMetadata: false });
        const n = doc.getPageCount();
        return n > 0 ? pass(`PDF with ${n} page(s)`) : fail("The PDF has no pages.");
      }
      case "docx": {
        const zip = await JSZip.loadAsync(buf(bytes));
        if (!zip.file("word/document.xml") || !zip.file("[Content_Types].xml")) return fail("The file is not a valid DOCX package.");
        const r = await mammoth.extractRawText(mammothInput(bytes));
        return pass(`DOCX package, ${r.value.length} characters of text`);
      }
      case "xlsx": {
        const zip = await JSZip.loadAsync(buf(bytes));
        if (!zip.file("xl/workbook.xml")) return fail("The file is not a valid XLSX package.");
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf(bytes));
        return pass(`XLSX with ${wb.worksheets.length} worksheet(s)`);
      }
      case "pptx": {
        const zip = await JSZip.loadAsync(buf(bytes));
        if (!zip.file("ppt/presentation.xml")) return fail("The file is not a valid PPTX package.");
        const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
        return pass(`PPTX with ${slides} slide(s)`);
      }
      case "odt":
      case "epub": {
        const zip = await JSZip.loadAsync(buf(bytes));
        const mime = zip.file("mimetype") ? await zip.file("mimetype")!.async("string") : "";
        const expected = kind === "odt" ? "application/vnd.oasis.opendocument.text" : "application/epub+zip";
        if (mime.trim() !== expected) return fail(`Missing or wrong mimetype entry (expected ${expected}).`);
        return pass(`${kind.toUpperCase()} container`);
      }
      case "png":
        return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) ? pass("PNG signature") : fail("Not a PNG file.");
      case "jpeg":
        return startsWith(bytes, [0xff, 0xd8, 0xff]) ? pass("JPEG signature") : fail("Not a JPEG file.");
      case "tiff":
        return startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
          ? pass("TIFF header")
          : fail("Not a TIFF file.");
      case "svg": {
        const text = new TextDecoder().decode(bytes).trim();
        return /<svg[\s>]/.test(text) && text.endsWith("</svg>") ? pass("SVG document") : fail("The SVG document is incomplete.");
      }
      case "txt":
      case "md":
      case "csv": {
        if (!isText(bytes)) return fail("The text output contains binary data.");
        const text = new TextDecoder().decode(bytes);
        if (kind === "csv" && !text.trim()) return fail("The CSV output is empty.");
        return pass(`${text.length} characters`);
      }
      case "html": {
        const text = new TextDecoder().decode(bytes).trimStart().toLowerCase();
        return text.startsWith("<!doctype html") || text.startsWith("<html") ? pass("HTML document") : fail("Not an HTML document.");
      }
      case "rtf": {
        const text = new TextDecoder().decode(bytes);
        return text.startsWith("{\\rtf1") && text.trimEnd().endsWith("}") ? pass("RTF document") : fail("Not a valid RTF document.");
      }
      case "zip": {
        const zip = await JSZip.loadAsync(buf(bytes));
        return pass(`ZIP archive with ${Object.keys(zip.files).length} entries`);
      }
    }
  } catch (e) {
    return fail(`The output could not be opened by its parser: ${(e as Error).message}`);
  }
}
