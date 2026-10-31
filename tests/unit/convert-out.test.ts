import { describe, expect, it } from "vitest";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as conv from "@/lib/pdf/convert-out";
import { layoutPage, type LayoutPage } from "@/lib/pdf/layout";
import { mammothInput, verifyOutput } from "@/lib/pdf/validate";

/** A page with a heading, a paragraph, a list and a numeric table (as produced by layout analysis). */
function samplePage(): LayoutPage {
  return layoutPage(0, 612, 792, [
    { str: "Quarterly", x: 50, y: 40, w: 150, h: 24 },
    { str: "Report", x: 210, y: 40, w: 120, h: 24 },
    { str: "Revenue grew steadily across regions.", x: 50, y: 100, w: 300, h: 11 },
    { str: "• Alpha item", x: 50, y: 150, w: 100, h: 11 },
    { str: "• Beta item", x: 50, y: 166, w: 100, h: 11 },
    { str: "Region", x: 50, y: 220, w: 40, h: 11 },
    { str: "Q1", x: 200, y: 220, w: 20, h: 11 },
    { str: "Q2", x: 350, y: 220, w: 20, h: 11 },
    { str: "North", x: 50, y: 240, w: 40, h: 11 },
    { str: "100", x: 200, y: 240, w: 20, h: 11 },
    { str: "120", x: 350, y: 240, w: 20, h: 11 },
    { str: "South", x: 50, y: 260, w: 40, h: 11 },
    { str: "90", x: 200, y: 260, w: 20, h: 11 },
    { str: "110", x: 350, y: 260, w: 20, h: 11 },
  ]);
}

const textPage = (): LayoutPage => layoutPage(0, 612, 792, [{ str: "Just prose here.", x: 50, y: 100, w: 200, h: 11 }]);

describe("PDF → DOCX", () => {
  it("writes a valid DOCX whose text, headings and tables round-trip through an independent parser", async () => {
    const bytes = await conv.toDocx([samplePage()], "editable");
    const check = await verifyOutput("docx", bytes);
    expect(check.ok).toBe(true);
    const parsed = await mammoth.convertToHtml(mammothInput(bytes));
    expect(parsed.value).toContain("<h1>Quarterly Report</h1>");
    expect(parsed.value).toContain("<table>");
    expect(parsed.value).toContain("North");
    expect(parsed.value).toContain("Alpha item");
  });

  it("layout mode embeds page images (no editable text is claimed)", async () => {
    const png = new Uint8Array(readFileSync(join(process.cwd(), "tests/fixtures/tiny.png")));
    const bytes = await conv.toDocx([samplePage()], "layout", async () => png);
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files);
    expect(names.some((n) => n.startsWith("word/media/"))).toBe(true);
  });
});

describe("PDF → XLSX / CSV", () => {
  it("creates a workbook whose numeric cells are real numbers", async () => {
    const bytes = await conv.toXlsx([samplePage()], "perTable");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes.slice().buffer as ArrayBuffer);
    expect(wb.worksheets).toHaveLength(1);
    const ws = wb.worksheets[0];
    expect(ws.getRow(1).getCell(1).value).toBe("Region");
    expect(ws.getRow(2).getCell(2).value).toBe(100);
    expect(typeof ws.getRow(2).getCell(3).value).toBe("number");
  });

  it("combined mode stacks tables on one sheet", async () => {
    const bytes = await conv.toXlsx([samplePage(), samplePage()], "single");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes.slice().buffer as ArrayBuffer);
    expect(wb.worksheets).toHaveLength(1);
    expect(wb.worksheets[0].rowCount).toBeGreaterThan(8);
  });

  it("CSV contains the detected table and refuses pages without tables", async () => {
    const csv = conv.toCsv([samplePage()]);
    expect(csv.split("\n")[0]).toBe("Region,Q1,Q2");
    expect(csv).toContain("South,90,110");
    expect(() => conv.toCsv([textPage()])).toThrow(conv.NoTableError);
    await expect(conv.toXlsx([textPage()], "perTable")).rejects.toBeInstanceOf(conv.NoTableError);
  });
});

describe("PDF → PPTX", () => {
  it("creates one slide per page with the expected text", async () => {
    const bytes = await conv.toPptx([samplePage(), textPage()], "editable");
    const check = await verifyOutput("pptx", bytes);
    expect(check.ok).toBe(true);
    expect(check.ok && check.detail).toContain("2 slide(s)");
    const zip = await JSZip.loadAsync(bytes);
    const slide1 = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(slide1).toContain("Quarterly");
    expect(slide1).toContain("Alpha item");
  });

  it("image mode places a page picture on each slide", async () => {
    const png = new Uint8Array(readFileSync(join(process.cwd(), "tests/fixtures/tiny.png")));
    const bytes = await conv.toPptx([textPage()], "image", async () => png);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).some((n) => n.startsWith("ppt/media/"))).toBe(true);
  });
});

describe("text, markup and package formats", () => {
  it("TXT, Markdown, HTML and RTF are valid and contain the content", async () => {
    const pages = [samplePage()];
    const txt = conv.toText(pages);
    expect(txt).toContain("--- Page 1 ---");
    expect(txt).toContain("Quarterly Report");
    expect((await verifyOutput("md", new TextEncoder().encode(conv.toMarkdown(pages)))).ok).toBe(true);
    expect(conv.toMarkdown(pages)).toContain("# Quarterly Report");
    const html = conv.toHtml(pages, "Doc");
    expect((await verifyOutput("html", new TextEncoder().encode(html))).ok).toBe(true);
    expect(html).toContain("<h1>Quarterly Report</h1>");
    const rtf = conv.toRtf(pages);
    expect((await verifyOutput("rtf", new TextEncoder().encode(rtf))).ok).toBe(true);
    expect(rtf).toContain("Quarterly Report");
  });

  it("EPUB and ODT are valid containers with the expected structure", async () => {
    const epub = await conv.toEpub([samplePage()], "Doc");
    expect((await verifyOutput("epub", epub)).ok).toBe(true);
    const epubZip = await JSZip.loadAsync(epub);
    expect(epubZip.file("OEBPS/page-1.xhtml")).not.toBeNull();
    const odt = await conv.toOdt([samplePage()], "Doc");
    expect((await verifyOutput("odt", odt)).ok).toBe(true);
    const odtZip = await JSZip.loadAsync(odt);
    expect(await odtZip.file("content.xml")!.async("string")).toContain("Quarterly Report");
  });

  it("SVG pages embed the image and keep the text selectable", async () => {
    const png = new Uint8Array(readFileSync(join(process.cwd(), "tests/fixtures/tiny.png")));
    const svg = conv.toSvg(samplePage(), png, "Doc");
    expect((await verifyOutput("svg", new TextEncoder().encode(svg))).ok).toBe(true);
    expect(svg).toContain("data:image/png;base64,");
    expect(svg).toContain("fill-opacity=\"0\"");
  });

  it("TIFF output is a valid TIFF with the pixels in place", async () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const tiff = conv.toTiff(rgba, 2, 2);
    expect((await verifyOutput("tiff", tiff)).ok).toBe(true);
  });
});
