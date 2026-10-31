import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts, degrees, rgb } from "@cantoo/pdf-lib";
import { buildEditedPdf, redactedUids } from "@/lib/pdf/export";
import { getPageText, openPdf, PdfOpenError, releasePdf } from "@/lib/pdf/pdfjs";
import { verifyRedaction } from "@/lib/pdf/document-export";
import type { EditState } from "@/lib/pdf/types";

const fixture = (name: string) => new Uint8Array(readFileSync(join(process.cwd(), "tests/fixtures", name)));

/** Two letter pages. Page 1 has a secret word at a known position; page 2 is rotated 90° in the source. */
async function makeSource(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]);
  p1.drawText("Hello World", { x: 72, y: 700, size: 14, font, color: rgb(0, 0, 0) });
  p1.drawText("SECRET-PAYLOAD", { x: 72, y: 600, size: 14, font, color: rgb(0, 0, 0) });
  const p2 = doc.addPage([612, 792]);
  p2.drawText("Rotated source page", { x: 72, y: 700, size: 14, font });
  p2.setRotation(degrees(90));
  return doc.save();
}

const entry = (uid: string, index: number, rot = 0) => ({ uid, src: "main", index, rot, crop: null });

describe("export engine", () => {
  it("embeds text and shape annotations, and keeps the page count and order", async () => {
    const source = await makeSource();
    const edit: EditState = {
      pages: [entry("a", 0), entry("b", 1)],
      anns: [
        { id: "h1", uid: "a", type: "highlight", x: 0.1, y: 0.1, w: 0.3, h: 0.03, color: "#facc15", opacity: 0.4, fontSize: 12 },
        { id: "t1", uid: "b", type: "text", x: 0.1, y: 0.2, w: 0.5, h: 0.06, text: "Added text", color: "#111827", opacity: 1, fontSize: 14, font: "helvetica" },
      ],
    };
    const out = await buildEditedPdf({ sources: { main: source }, edit });
    expect(out.pageCount).toBe(2);
    expect(out.warnings).toEqual([]);
    const pdf = await openPdf(out.bytes);
    expect(pdf.numPages).toBe(2);
    const text = (await getPageText(await pdf.getPage(2))).text;
    expect(text).toContain("Rotated source page");
    expect(text).toContain("Added text");
    releasePdf(pdf);
  });

  it("places annotations in page space on rotated pages (same coordinates as the editor)", async () => {
    const source = await makeSource();
    const edit: EditState = {
      pages: [entry("b", 1, 0)],
      anns: [{ id: "t1", uid: "b", type: "text", x: 0.25, y: 0.5, w: 0.5, h: 0.06, text: "Anchor", color: "#000000", opacity: 1, fontSize: 14, font: "helvetica" }],
    };
    const out = await buildEditedPdf({ sources: { main: source }, edit });
    const pdf = await openPdf(out.bytes);
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const item = content.items.find((i) => "str" in i && i.str === "Anchor") as { transform: number[] } | undefined;
    expect(item).toBeDefined();
    // Editor mapping: X = u * W + 3pt padding; baseline ~ (1 - v) * H - ascent.
    expect(item!.transform[4]).toBeGreaterThan(0.25 * 612 + 2);
    expect(item!.transform[4]).toBeLessThan(0.25 * 612 + 5);
    expect(item!.transform[5]).toBeGreaterThan((1 - 0.5) * 792 - 20);
    expect(item!.transform[5]).toBeLessThan((1 - 0.5) * 792 + 2);
    releasePdf(pdf);
  });

  it("applies the page rotation to the output page", async () => {
    const source = await makeSource();
    const edit: EditState = { pages: [entry("b", 1, 90)], anns: [] };
    const out = await buildEditedPdf({ sources: { main: source }, edit });
    const reloaded = await PDFDocument.load(out.bytes);
    expect(reloaded.getPage(0).getRotation().angle).toBe(180);
  });

  it("produces A4 pages when a paper size is requested", async () => {
    const source = await makeSource();
    const out = await buildEditedPdf({ sources: { main: source }, edit: { pages: [entry("a", 0)], anns: [] }, options: { paperSize: "A4" } });
    const reloaded = await PDFDocument.load(out.bytes);
    const { width, height } = reloaded.getPage(0).getSize();
    expect(width).toBeCloseTo(595.28, 1);
    expect(height).toBeCloseTo(841.89, 1);
  });

  it("crops pages with a CropBox", async () => {
    const source = await makeSource();
    const out = await buildEditedPdf({
      sources: { main: source },
      edit: { pages: [{ ...entry("a", 0), crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }], anns: [] },
    });
    const reloaded = await PDFDocument.load(out.bytes);
    const crop = reloaded.getPage(0).getCropBox();
    expect(crop.width).toBeCloseTo(306, 0);
    expect(crop.height).toBeCloseTo(396, 0);
  });

  it("secure redaction removes the covered text from the output (verified by extraction)", async () => {
    const source = await makeSource();
    const edit: EditState = {
      pages: [entry("a", 0), entry("b", 1)],
      anns: [{ id: "r1", uid: "a", type: "redact", x: 0.1, y: 0.1, w: 0.5, h: 0.12, color: "#000000", opacity: 1, fontSize: 12 }],
    };
    expect(redactedUids(edit)).toEqual(["a"]);
    // The redacted page is replaced by a raster image, so no text layer is carried over.
    const rasters = { a: { bytes: fixture("white-letter.jpg"), W: 612, H: 792 } };
    const out = await buildEditedPdf({ sources: { main: source }, edit, rasters });
    const pdf = await openPdf(out.bytes);
    const pageText = (await getPageText(await pdf.getPage(1))).text;
    expect(pageText).not.toContain("SECRET");
    expect(pageText).not.toContain("Hello");
    // Pages without redaction keep their text.
    expect((await getPageText(await pdf.getPage(2))).text).toContain("Rotated source page");
    releasePdf(pdf);

    const sourcePdf = await openPdf(source);
    const verdict = await verifyRedaction({ bytes: source.slice().buffer as ArrayBuffer, sources: [], pdfs: { main: sourcePdf } }, edit, out.bytes);
    expect(verdict.checkedPages).toBe(1);
    expect(verdict.ok).toBe(true);
    releasePdf(sourcePdf);
  });

  it("visual-only redaction keeps the text (and says so)", async () => {
    const source = await makeSource();
    const edit: EditState = {
      pages: [entry("a", 0)],
      anns: [{ id: "r1", uid: "a", type: "redact", x: 0.1, y: 0.1, w: 0.5, h: 0.12, color: "#000000", opacity: 1, fontSize: 12 }],
    };
    const out = await buildEditedPdf({ sources: { main: source }, edit });
    const pdf = await openPdf(out.bytes);
    expect((await getPageText(await pdf.getPage(1))).text).toContain("SECRET");
    releasePdf(pdf);
  });

  it("password protection requires the password to open the file", async () => {
    const source = await makeSource();
    const out = await buildEditedPdf({
      sources: { main: source },
      edit: { pages: [entry("a", 0)], anns: [] },
      options: { encrypt: { ownerPassword: "owner-123", userPassword: "open-456", permissions: { printing: false, copying: false, modifying: false, annotating: true, fillingForms: true } } },
    });
    await expect(PDFDocument.load(out.bytes)).rejects.toThrow();
    await expect(openPdf(out.bytes)).rejects.toBeInstanceOf(PdfOpenError);
    const withPw = await openPdf(out.bytes, "open-456");
    expect(withPw.numPages).toBe(1);
    releasePdf(withPw);
  });

  it("reports unencodable characters as warnings instead of dropping them silently", async () => {
    const source = await makeSource();
    const out = await buildEditedPdf({
      sources: { main: source },
      edit: { pages: [entry("a", 0)], anns: [{ id: "t", uid: "a", type: "text", x: 0.1, y: 0.3, w: 0.6, h: 0.08, text: "Price 😀 → €5", color: "#000", opacity: 1, fontSize: 12, font: "helvetica" }] },
    });
    expect(out.warnings.some((w) => w.includes("replaced with '?'"))).toBe(true);
  });
});
