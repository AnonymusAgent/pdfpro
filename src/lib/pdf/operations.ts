/**
 * Document operations used by the Merge/Split/Batch tools and the editor's utilities.
 * In-place operations (rotate, watermark, encrypt) keep the original document structure;
 * operations that rebuild pages say so in their result.
 */
import { PDFDocument, StandardFonts, degrees, rgb } from "@cantoo/pdf-lib";
import { applyDecorations, hexColor, type DecorationOptions, type EncryptOptions } from "./export";
import { normRot } from "./geometry";

export type NamedBytes = { name: string; bytes: Uint8Array };

export class OperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationError";
  }
}

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    throw new OperationError(`The PDF could not be read (${(e as Error).message}). It may be damaged or password-protected.`);
  }
}

/** Merges documents in the given order. Copies pages; each input keeps its own page content. */
export async function mergeDocuments(inputs: NamedBytes[]): Promise<{ bytes: Uint8Array; pageCount: number }> {
  if (!inputs.length) throw new OperationError("Add at least one PDF to merge.");
  const out = await PDFDocument.create({ updateMetadata: false });
  for (const input of inputs) {
    const src = await load(input.bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  out.setProducer("PDF Pro");
  out.setCreator("PDF Pro");
  return { bytes: new Uint8Array(await out.save({ useObjectStreams: true })), pageCount: out.getPageCount() };
}

/** Parses "1-3, 5, 8-10" into groups of zero-based page indexes. Throws on invalid input. */
export function parsePageRanges(spec: string, pageCount: number): number[][] {
  const groups: number[][] = [];
  const parts = spec.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new OperationError("Enter at least one page or range, for example 1-3, 5.");
  for (const part of parts) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) throw new OperationError(`"${part}" is not a valid page or range.`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < 1 || a > pageCount || b > pageCount) {
      throw new OperationError(`"${part}" is outside the document (it has ${pageCount} pages).`);
    }
    if (b < a) throw new OperationError(`"${part}" ends before it starts.`);
    groups.push(Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i));
  }
  return groups;
}

export async function extractPages(bytes: Uint8Array, indexes: number[]): Promise<Uint8Array> {
  if (!indexes.length) throw new OperationError("No pages selected.");
  const src = await load(bytes);
  const out = await PDFDocument.create({ updateMetadata: false });
  const copied = await out.copyPages(src, indexes);
  copied.forEach((p) => out.addPage(p));
  out.setProducer("PDF Pro");
  return new Uint8Array(await out.save({ useObjectStreams: true }));
}

export async function splitByRanges(bytes: Uint8Array, spec: string, baseName: string): Promise<NamedBytes[]> {
  const src = await load(bytes);
  const groups = parsePageRanges(spec, src.getPageCount());
  const outputs: NamedBytes[] = [];
  for (const g of groups) {
    outputs.push({
      name: `${baseName}-pages-${g[0] + 1}-${g[g.length - 1] + 1}.pdf`,
      bytes: await extractPages(bytes, g),
    });
  }
  return outputs;
}

export async function splitEachPage(bytes: Uint8Array, baseName: string): Promise<NamedBytes[]> {
  const src = await load(bytes);
  const outputs: NamedBytes[] = [];
  for (let i = 0; i < src.getPageCount(); i++) {
    outputs.push({ name: `${baseName}-page-${String(i + 1).padStart(3, "0")}.pdf`, bytes: await extractPages(bytes, [i]) });
  }
  return outputs;
}

/** Rotates pages in place (adds `degrees` to each page's /Rotate). Keeps bookmarks, forms and metadata. */
export async function rotatePages(bytes: Uint8Array, deg: number, indexes?: number[]): Promise<Uint8Array> {
  if (deg % 90 !== 0) throw new OperationError("Rotation must be a multiple of 90 degrees.");
  const doc = await load(bytes);
  const pages = doc.getPages();
  const targets = indexes ?? pages.map((_, i) => i);
  for (const i of targets) {
    const p = pages[i];
    if (!p) continue;
    p.setRotation(degrees(normRot(p.getRotation().angle + deg)));
  }
  return new Uint8Array(await doc.save({ useObjectStreams: true }));
}

/** Adds watermark / header / footer / page numbers / Bates numbers in place. */
export async function decorateDocument(bytes: Uint8Array, opts: DecorationOptions): Promise<Uint8Array> {
  const doc = await load(bytes);
  const warnings = new Set<string>();
  await applyDecorations(doc, doc.getPages(), opts, warnings);
  return new Uint8Array(await doc.save({ useObjectStreams: true }));
}

/**
 * Password protection with the standard PDF security handler (RC4/AES, as chosen by the library).
 * Keeps the document structure intact. Returns the encrypted bytes.
 */
export async function encryptDocument(bytes: Uint8Array, e: EncryptOptions): Promise<Uint8Array> {
  if (!e.ownerPassword || e.ownerPassword.length < 4) throw new OperationError("The owner password must be at least 4 characters.");
  const doc = await load(bytes);
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
  return new Uint8Array(await doc.save());
}

/**
 * Removes password protection. Requires the password that opens the file; the caller must confirm
 * the user is authorized to remove protection from this document.
 */
export async function removePassword(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, password } as Parameters<typeof PDFDocument.load>[1]);
  } catch (e) {
    throw new OperationError(`Could not unlock the PDF with that password (${(e as Error).message}).`);
  }
  return new Uint8Array(await doc.save());
}

/** Lossless structural optimization: re-serializes with object streams and drops unreferenced objects. */
export async function losslessOptimize(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await load(bytes);
  return new Uint8Array(await doc.save({ useObjectStreams: true }));
}

export async function createBlankPdf(width = 595.28, height = 841.89): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([width, height]);
  doc.setTitle("Untitled");
  doc.setProducer("PDF Pro");
  return new Uint8Array(await doc.save());
}

/** A real, multi-page sample PDF with text, a table and a second page. Generated locally. */
export async function createSamplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const navy = hexColor("#0c1d33") ?? rgb(0.05, 0.1, 0.2);
  const p1 = doc.addPage([595.28, 841.89]);
  p1.drawText("PDF Pro — Sample Report", { x: 54, y: 780, size: 22, font: bold, color: navy });
  p1.drawText("Quarterly revenue summary generated locally for testing every tool.", { x: 54, y: 758, size: 11, font: reg, color: rgb(0.3, 0.35, 0.45) });
  const body = [
    "This document is generated in your browser so you can try annotations, text",
    "insertion, page management, OCR text layers, conversions and secure redaction",
    "without uploading anything. The table below can be converted to Excel or CSV.",
  ];
  body.forEach((l, i) => p1.drawText(l, { x: 54, y: 720 - i * 16, size: 11, font: reg }));
  const rows = [
    ["Region", "Q1 revenue", "Q2 revenue", "Growth"],
    ["North America", "1,240,500", "1,412,300", "13.9%"],
    ["Europe", "905,120", "988,700", "9.2%"],
    ["Asia Pacific", "678,900", "802,450", "18.2%"],
  ];
  const colX = [54, 230, 340, 450];
  rows.forEach((r, ri) => {
    r.forEach((c, ci) => p1.drawText(c, { x: colX[ci], y: 600 - ri * 22, size: 11, font: ri === 0 ? bold : reg, color: ri === 0 ? navy : rgb(0.1, 0.1, 0.12) }));
  });
  const p2 = doc.addPage([595.28, 841.89]);
  p2.drawText("Page 2 — Next steps", { x: 54, y: 780, size: 18, font: bold, color: navy });
  [
    "1. Review the figures and add comments.",
    "2. Insert a signature from the Sign & Secure page.",
    "3. Reorder or extract pages from the thumbnails panel.",
    "4. Export to DOCX, XLSX or PPTX from the Convert center.",
    "5. Apply secure redaction before sharing sensitive text.",
  ].forEach((l, i) => p2.drawText(l, { x: 54, y: 740 - i * 20, size: 12, font: reg }));
  doc.setTitle("PDF Pro sample report");
  doc.setAuthor("PDF Pro");
  doc.setProducer("PDF Pro");
  return new Uint8Array(await doc.save());
}

export async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await load(bytes)).getPageCount();
}
