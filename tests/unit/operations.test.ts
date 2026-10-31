import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { createSamplePdf, decorateDocument, extractPages, losslessOptimize, mergeDocuments, parsePageRanges, rotatePages, splitByRanges, splitEachPage, OperationError } from "@/lib/pdf/operations";
import { getPageText, openPdf, releasePdf } from "@/lib/pdf/pdfjs";

async function pages(count: number, label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`${label} page ${i + 1}`, { x: 72, y: 700, size: 18, font });
  }
  return doc.save();
}

const pageCountOf = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();

describe("page ranges", () => {
  it("parses ranges and single pages into zero-based indexes", () => {
    expect(parsePageRanges("1-2, 4", 5)).toEqual([[0, 1], [3]]);
  });

  it("rejects out-of-range, reversed and malformed input with clear messages", () => {
    expect(() => parsePageRanges("6", 5)).toThrow(OperationError);
    expect(() => parsePageRanges("3-1", 5)).toThrow(/ends before/);
    expect(() => parsePageRanges("a-b", 5)).toThrow(/not a valid/);
    expect(() => parsePageRanges("", 5)).toThrow(/at least one/);
  });
});

describe("merge, split and extract", () => {
  it("merges documents in order", async () => {
    const merged = await mergeDocuments([
      { name: "a.pdf", bytes: await pages(2, "A") },
      { name: "b.pdf", bytes: await pages(3, "B") },
    ]);
    expect(merged.pageCount).toBe(5);
    const pdf = await openPdf(merged.bytes);
    expect((await getPageText(await pdf.getPage(1))).text).toContain("A page 1");
    expect((await getPageText(await pdf.getPage(5))).text).toContain("B page 3");
    releasePdf(pdf);
  });

  it("splits by ranges into separate valid PDFs", async () => {
    const parts = await splitByRanges(await pages(3, "S"), "1-2, 3", "doc");
    expect(parts.map((p) => p.name)).toEqual(["doc-pages-1-2.pdf", "doc-pages-3-3.pdf"]);
    expect(await pageCountOf(parts[0].bytes)).toBe(2);
    expect(await pageCountOf(parts[1].bytes)).toBe(1);
  });

  it("splits every page into its own PDF", async () => {
    const parts = await splitEachPage(await pages(4, "E"), "doc");
    expect(parts).toHaveLength(4);
    for (const p of parts) expect(await pageCountOf(p.bytes)).toBe(1);
  });

  it("extracts selected pages in the requested order", async () => {
    const out = await extractPages(await pages(4, "X"), [3, 0]);
    const pdf = await openPdf(out);
    expect((await getPageText(await pdf.getPage(1))).text).toContain("X page 4");
    expect((await getPageText(await pdf.getPage(2))).text).toContain("X page 1");
    releasePdf(pdf);
  });
});

describe("in-place operations", () => {
  it("rotates pages by adding to their rotation", async () => {
    const out = await rotatePages(await pages(2, "R"), 90);
    const doc = await PDFDocument.load(out);
    expect(doc.getPage(0).getRotation().angle).toBe(90);
    expect(doc.getPage(1).getRotation().angle).toBe(90);
    await expect(rotatePages(await pages(1, "R"), 45)).rejects.toThrow(/multiple of 90/);
  });

  it("adds a watermark, page numbers and a header that are extractable", async () => {
    const out = await decorateDocument(await pages(2, "W"), { watermark: { text: "DRAFT" }, pageNumbers: true, headerText: "Head" });
    const pdf = await openPdf(out);
    const text = (await getPageText(await pdf.getPage(1))).text;
    expect(text).toContain("DRAFT");
    expect(text).toContain("1 / 2");
    expect(text).toContain("Head");
    releasePdf(pdf);
  });

  it("lossless optimization keeps text and page count", async () => {
    const out = await losslessOptimize(await pages(2, "L"));
    expect(await pageCountOf(out)).toBe(2);
    const pdf = await openPdf(out);
    expect((await getPageText(await pdf.getPage(2))).text).toContain("L page 2");
    releasePdf(pdf);
  });

  it("creates a real multi-page sample document", async () => {
    const pdf = await openPdf(await createSamplePdf());
    expect(pdf.numPages).toBe(2);
    expect((await getPageText(await pdf.getPage(1))).text).toContain("Quarterly revenue");
    releasePdf(pdf);
  });
});
