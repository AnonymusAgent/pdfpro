import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";
import { fileToPdf, htmlToBlocks, imagesToPdf, markdownToBlocks, textToBlocks, UnsupportedFormatError } from "@/lib/pdf/convert-in";
import { getPageText, openPdf, releasePdf } from "@/lib/pdf/pdfjs";
import { verifyOutput } from "@/lib/pdf/validate";

async function textOf(pdfBytes: Uint8Array): Promise<string> {
  const pdf = await openPdf(pdfBytes);
  const parts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) parts.push((await getPageText(await pdf.getPage(i))).text);
  releasePdf(pdf);
  return parts.join("\n");
}

describe("markup parsing", () => {
  it("Markdown headings, lists and tables become blocks", () => {
    const blocks = markdownToBlocks("# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(blocks[0]).toEqual({ type: "h", level: 1, text: "Title" });
    expect(blocks.filter((b) => b.type === "li")).toHaveLength(2);
    expect(blocks.find((b) => b.type === "table")).toEqual({ type: "table", rows: [["a", "b"], ["1", "2"]] });
  });

  it("HTML headings, paragraphs, lists and tables are decoded (entities included)", () => {
    const blocks = htmlToBlocks("<h2>Sales &amp; Costs</h2><p>Net &lt; 5</p><ul><li>Item</li></ul><table><tr><td>A</td><td>1&amp;2</td></tr></table>");
    expect(blocks[0]).toEqual({ type: "h", level: 2, text: "Sales & Costs" });
    expect(blocks[1]).toEqual({ type: "p", text: "Net < 5" });
    expect(blocks[3]).toEqual({ type: "table", rows: [["A", "1&2"]] });
  });

  it("plain text keeps paragraphs separated by blank lines", () => {
    expect(textToBlocks("First.\n\nSecond line\nstill second.")).toHaveLength(2);
  });
});

describe("Office and text files → PDF", () => {
  it("Markdown converts to a PDF whose text is extractable", async () => {
    const r = await fileToPdf({ name: "notes.md", bytes: new TextEncoder().encode("# Project Notes\n\nDetails about the project.\n\n- Milestone one") });
    expect((await verifyOutput("pdf", r.bytes)).ok).toBe(true);
    const text = await textOf(r.bytes);
    expect(text).toContain("Project Notes");
    expect(text).toContain("Milestone one");
  });

  it("DOCX converts with headings, paragraphs and tables", async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Board Summary")] }),
            new Paragraph({ children: [new TextRun("Revenue is up this quarter.")] }),
            new Table({
              rows: [
                new TableRow({ children: [new TableCell({ children: [new Paragraph("Metric")] }), new TableCell({ children: [new Paragraph("Value")] })] }),
                new TableRow({ children: [new TableCell({ children: [new Paragraph("Users")] }), new TableCell({ children: [new Paragraph("4200")] })] }),
              ],
            }),
          ],
        },
      ],
    });
    const bytes = new Uint8Array(await Packer.toBuffer(doc));
    const r = await fileToPdf({ name: "summary.docx", bytes });
    expect((await verifyOutput("pdf", r.bytes)).ok).toBe(true);
    const text = await textOf(r.bytes);
    expect(text).toContain("Board Summary");
    expect(text).toContain("Revenue is up this quarter.");
    expect(text).toContain("4200");
  });

  it("XLSX converts with every sheet and cell value", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Budget");
    ws.addRow(["Item", "Cost"]);
    ws.addRow(["Hardware", 1250]);
    ws.addRow(["Software", 830]);
    const bytes = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const r = await fileToPdf({ name: "budget.xlsx", bytes });
    expect((await verifyOutput("pdf", r.bytes)).ok).toBe(true);
    const text = await textOf(r.bytes);
    expect(text).toContain("Budget");
    expect(text).toContain("Hardware");
    expect(text).toContain("1250");
  });

  it("PPTX converts one page per slide with the slide text", async () => {
    const pptx = new PptxGenJS();
    const slide = pptx.addSlide();
    slide.addText("Launch Plan 2026", { x: 1, y: 1, w: 8, h: 1, fontSize: 32 });
    slide.addText("Milestone: beta in March", { x: 1, y: 3, w: 8, h: 1, fontSize: 18 });
    pptx.addSlide().addText("Second slide words", { x: 1, y: 1, w: 8, h: 1, fontSize: 24 });
    const bytes = (await pptx.write({ outputType: "uint8array" })) as Uint8Array;
    const r = await fileToPdf({ name: "deck.pptx", bytes: new Uint8Array(bytes) });
    const pdf = await openPdf(r.bytes);
    expect(pdf.numPages).toBe(2);
    expect((await getPageText(await pdf.getPage(1))).text).toContain("Launch Plan 2026");
    expect((await getPageText(await pdf.getPage(2))).text).toContain("Second slide words");
    releasePdf(pdf);
  });

  it("images convert to a PDF page per image (PNG)", async () => {
    const png = new Uint8Array(readFileSync(join(process.cwd(), "tests/fixtures/sample-scan.png")));
    const bytes = await imagesToPdf([{ name: "scan.png", bytes: png }], true, new Set());
    const check = await verifyOutput("pdf", bytes);
    expect(check.ok).toBe(true);
    expect(check.ok && check.detail).toContain("1 page");
  });

  it("legacy binary Office formats are rejected with an explanation, not mis-converted", async () => {
    await expect(fileToPdf({ name: "old.doc", bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]) })).rejects.toBeInstanceOf(UnsupportedFormatError);
    await expect(fileToPdf({ name: "old.xls", bytes: new Uint8Array([1]) })).rejects.toThrow(/LibreOffice/);
  });
});
