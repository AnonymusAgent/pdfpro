/**
 * PDF → other formats. Input is the layout analysis of each page (see layout.ts), plus optional
 * page renders for layout/image-preserving modes. Every function returns real bytes in the target
 * format; the caller validates them with validate.ts before offering a download.
 */
import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  PageBreak,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";
import { bytesToBase64 } from "../browser";
import { parseNumber, type Block, type LayoutPage, type TableCell as Cell } from "./layout";

export type RenderPng = (pageIndex: number) => Promise<Uint8Array>;

export class NoTableError extends Error {
  constructor() {
    super("No tabular data was detected in this PDF, so a table-based output could not be created.");
    this.name = "NoTableError";
  }
}

type TableBlock = Extract<Block, { type: "table" }>;

const tablesOf = (pages: LayoutPage[]): { page: number; table: TableBlock }[] =>
  pages.flatMap((p) => p.blocks.filter((b): b is TableBlock => b.type === "table").map((table) => ({ page: p.index + 1, table })));

export function tableCount(pages: LayoutPage[]): number {
  return tablesOf(pages).length;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function blocksToPlain(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case "heading":
        case "paragraph":
          return b.text;
        case "list":
          return b.items.map((i) => `• ${i}`).join("\n");
        case "table":
          return b.rows.map((r) => r.map((c) => c.text).join("\t")).join("\n");
      }
    })
    .join("\n\n");
}

export function toText(pages: LayoutPage[]): string {
  return pages.map((p) => `--- Page ${p.index + 1} ---\n${blocksToPlain(p.blocks)}`).join("\n\n") + "\n";
}

function mdTable(rows: Cell[][]): string {
  if (!rows.length) return "";
  const width = rows[0].length;
  const line = (r: Cell[]) => `| ${r.map((c) => c.text.replace(/\|/g, "\\|")).join(" | ")} |`;
  return [line(rows[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

export function toMarkdown(pages: LayoutPage[]): string {
  return (
    pages
      .map((p) =>
        p.blocks
          .map((b) => {
            switch (b.type) {
              case "heading":
                return `${"#".repeat(b.level)} ${b.text}`;
              case "paragraph":
                return b.text;
              case "list":
                return b.items.map((i) => `- ${i}`).join("\n");
              case "table":
                return mdTable(b.rows);
            }
          })
          .join("\n\n"),
      )
      .join("\n\n---\n\n") + "\n"
  );
}

export function toHtml(pages: LayoutPage[], title: string): string {
  const body = pages
    .map(
      (p) =>
        `<section class="page" data-page="${p.index + 1}">\n` +
        p.blocks
          .map((b) => {
            switch (b.type) {
              case "heading":
                return `<h${b.level}>${esc(b.text)}</h${b.level}>`;
              case "paragraph":
                return `<p>${esc(b.text)}</p>`;
              case "list":
                return `<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
              case "table":
                return `<table>${b.rows
                  .map((r) => `<tr>${r.map((c) => `<td>${esc(c.text)}</td>`).join("")}</tr>`)
                  .join("")}</table>`;
            }
          })
          .join("\n") +
        "\n</section>",
    )
    .join("\n");
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:Georgia,serif;max-width:820px;margin:40px auto;line-height:1.6;color:#111}table{border-collapse:collapse;margin:12px 0}td{border:1px solid #bbb;padding:4px 8px}section.page{border-bottom:1px solid #ddd;padding-bottom:24px;margin-bottom:24px}</style></head><body>\n${body}\n</body></html>\n`;
}

const csvCell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** CSV of every detected table, separated by a blank line. Throws NoTableError when none exist. */
export function toCsv(pages: LayoutPage[]): string {
  const tables = tablesOf(pages);
  if (!tables.length) throw new NoTableError();
  return tables.map(({ table }) => table.rows.map((r) => r.map((c) => csvCell(c.text)).join(",")).join("\n")).join("\n\n") + "\n";
}

const rtfEsc = (s: string) => {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const c = s.charCodeAt(i);
    if (ch === "\\") out += "\\\\";
    else if (ch === "{") out += "\\{";
    else if (ch === "}") out += "\\}";
    else if (ch === "\n") out += "\\line ";
    else if (c < 32) out += " ";
    else if (c > 127) out += `\\u${c > 32767 ? c - 65536 : c}?`;
    else out += ch;
  }
  return out;
};

export function toRtf(pages: LayoutPage[]): string {
  const body = pages
    .map((p) =>
      p.blocks
        .map((b) => {
          switch (b.type) {
            case "heading":
              return `\\b\\fs${b.level === 1 ? 32 : b.level === 2 ? 28 : 24} ${rtfEsc(b.text)}\\b0\\fs22\\par`;
            case "paragraph":
              return `${rtfEsc(b.text)}\\par`;
            case "list":
              return b.items.map((i) => `\\bullet\\tab ${rtfEsc(i)}\\par`).join("\n");
            case "table":
              return b.rows.map((r) => r.map((c) => rtfEsc(c.text)).join("\\tab ") + "\\par").join("\n");
          }
        })
        .join("\n"),
    )
    .join("\n\\page\n");
  return `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0\\fs22\n${body}\n}`;
}

async function packDocx(doc: Document): Promise<Uint8Array> {
  if (typeof window !== "undefined") return new Uint8Array(await (await Packer.toBlob(doc)).arrayBuffer());
  return new Uint8Array(await Packer.toBuffer(doc));
}

/**
 * DOCX output. "editable": headings, paragraphs, lists and real Word tables.
 * "layout": each page embedded as an image so the look is preserved (text is not editable).
 */
export async function toDocx(pages: LayoutPage[], mode: "editable" | "layout", renderPng?: RenderPng): Promise<Uint8Array> {
  const children: (Paragraph | Table)[] = [];
  const headingLevels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
  for (const p of pages) {
    if (p.index > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
    if (mode === "layout") {
      if (!renderPng) throw new Error("Layout mode needs page renders.");
      const png = await renderPng(p.index);
      const width = 600;
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new ImageRun({ type: "png", data: png, transformation: { width, height: Math.round((width * p.height) / p.width) } })],
        }),
      );
      continue;
    }
    for (const b of p.blocks) {
      if (b.type === "heading") {
        children.push(new Paragraph({ heading: headingLevels[b.level - 1], children: [new TextRun(b.text)] }));
      } else if (b.type === "paragraph") {
        children.push(new Paragraph({ children: [new TextRun(b.text)], spacing: { after: 160 } }));
      } else if (b.type === "list") {
        for (const item of b.items) children.push(new Paragraph({ children: [new TextRun(`• ${item}`)], indent: { left: 360 } }));
      } else {
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: b.rows.map(
              (r) =>
                new TableRow({
                  children: r.map(
                    (c) =>
                      new TableCell({
                        children: [
                          new Paragraph({
                            alignment: c.numeric ? AlignmentType.RIGHT : AlignmentType.LEFT,
                            children: [new TextRun(c.text)],
                          }),
                        ],
                      }),
                  ),
                }),
            ),
          }),
        );
        children.push(new Paragraph({ children: [] }));
      }
    }
  }
  if (!children.length) children.push(new Paragraph({ children: [new TextRun("")] }));
  return packDocx(new Document({ creator: "PDF Pro", sections: [{ children }] }));
}

function sheetName(raw: string, used: Set<string>): string {
  let base = raw.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
  let name = base;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${n++})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

/**
 * XLSX output. perTable: one worksheet per detected table. single: all tables stacked on one sheet.
 * Numeric-looking cells are stored as numbers, so formulas and sorting work in Excel.
 */
export async function toXlsx(pages: LayoutPage[], mode: "perTable" | "single"): Promise<Uint8Array> {
  const tables = tablesOf(pages);
  if (!tables.length) throw new NoTableError();
  const wb = new ExcelJS.Workbook();
  wb.creator = "PDF Pro";
  const used = new Set<string>();
  const cellValue = (c: Cell) => (c.numeric ? (parseNumber(c.text) ?? c.text) : c.text);

  if (mode === "perTable") {
    tables.forEach(({ page, table }, k) => {
      const ws = wb.addWorksheet(sheetName(`P${page}-T${k + 1}`, used));
      table.rows.forEach((r, ri) => {
        const row = ws.addRow(r.map(cellValue));
        if (ri === 0 && r.every((c) => !c.numeric)) row.font = { bold: true };
      });
      ws.views = [{ state: "frozen", ySplit: 1 }];
      const widths = table.rows[0].map((_, c) => Math.min(48, Math.max(10, ...table.rows.map((r) => (r[c]?.text ?? "").length + 2))));
      ws.columns = widths.map((w) => ({ width: w }));
    });
  } else {
    const ws = wb.addWorksheet(sheetName("Tables", used));
    tables.forEach(({ page, table }, k) => {
      if (k > 0) ws.addRow([]);
      ws.addRow([`Page ${page} — table ${k + 1}`]).font = { bold: true };
      table.rows.forEach((r, ri) => {
        const row = ws.addRow(r.map(cellValue));
        if (ri === 0 && r.every((c) => !c.numeric)) row.font = { bold: true };
      });
    });
  }
  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

/**
 * PPTX output with the same page dimensions as the PDF.
 * editable: headings, text and tables as native PowerPoint objects (positions approximate).
 * image: each page as a full-slide picture (high fidelity, not editable).
 */
export async function toPptx(pages: LayoutPage[], mode: "editable" | "image", renderPng?: RenderPng): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.author = "PDF Pro";
  pptx.title = "PDF Pro export";
  const first = pages[0];
  const wIn = first.width / 72;
  const hIn = first.height / 72;
  pptx.defineLayout({ name: "PDFPAGE", width: wIn, height: hIn });
  pptx.layout = "PDFPAGE";
  for (const p of pages) {
    const slide = pptx.addSlide();
    if (mode === "image") {
      if (!renderPng) throw new Error("Image mode needs page renders.");
      const png = await renderPng(p.index);
      slide.addImage({ data: `data:image/png;base64,${bytesToBase64(png)}`, x: 0, y: 0, w: wIn, h: hIn });
      continue;
    }
    const marginX = Math.min(0.6, wIn * 0.08);
    const usableW = wIn - 2 * marginX;
    for (const b of p.blocks) {
      const y = Math.max(0.1, b.top / 72);
      if (b.type === "heading") {
        slide.addText(b.text, { x: marginX, y, w: usableW, h: 0.6, fontSize: Math.max(14, 30 - 6 * b.level), bold: true, color: "1F2937", valign: "top" });
      } else if (b.type === "paragraph") {
        const h = Math.min(hIn - y - 0.1, Math.max(0.4, b.text.length / 110 + 0.4));
        slide.addText(b.text, { x: marginX, y, w: usableW, h: Math.max(0.3, h), fontSize: 13, color: "111827", valign: "top" });
      } else if (b.type === "list") {
        slide.addText(
          b.items.map((t) => ({ text: t, options: { bullet: true, breakLine: true } })),
          { x: marginX, y, w: usableW, h: Math.max(0.4, b.items.length * 0.3), fontSize: 13, color: "111827", valign: "top" },
        );
      } else {
        const rows = b.rows.map((r, ri) =>
          r.map((c) => ({
            text: c.text,
            options: { bold: ri === 0, fontSize: 10, align: c.numeric ? ("right" as const) : ("left" as const) },
          })),
        );
        slide.addTable(rows, { x: marginX, y, w: usableW, border: { type: "solid", pt: 0.5, color: "9CA3AF" }, fontSize: 10 });
      }
    }
  }
  const out = (await pptx.write({ outputType: "uint8array" })) as Uint8Array;
  return new Uint8Array(out);
}

async function zipWithMimetype(mimetype: string, files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("mimetype", mimetype, { compression: "STORE" });
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: mimetype });
}

const xhtmlBody = (p: LayoutPage) =>
  p.blocks
    .map((b) => {
      switch (b.type) {
        case "heading":
          return `<h${b.level}>${esc(b.text)}</h${b.level}>`;
        case "paragraph":
          return `<p>${esc(b.text)}</p>`;
        case "list":
          return `<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
        case "table":
          return `<table border="1">${b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c.text)}</td>`).join("")}</tr>`).join("")}</table>`;
      }
    })
    .join("\n");

/** EPUB 3 (reflowable): one XHTML document per PDF page with a navigation document. */
export async function toEpub(pages: LayoutPage[], title: string): Promise<Uint8Array> {
  const id = `urn:pdfpro:${Date.now().toString(36)}`;
  const items = pages.map((p, i) => `<item id="p${i + 1}" href="page-${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join("");
  const spine = pages.map((_, i) => `<itemref idref="p${i + 1}"/>`).join("");
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">${id}</dc:identifier><dc:title>${esc(title)}</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>${items}</manifest>
<spine>${spine}</spine></package>`;
  const nav = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc" id="toc"><ol>${pages
    .map((_, i) => `<li><a href="page-${i + 1}.xhtml">Page ${i + 1}</a></li>`)
    .join("")}</ol></nav></body></html>`;
  const files: Record<string, string> = {
    "META-INF/container.xml": `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    "OEBPS/content.opf": opf,
    "OEBPS/nav.xhtml": nav,
    "OEBPS/style.css": "body{font-family:serif;line-height:1.5;margin:4%}table{border-collapse:collapse}td{padding:2px 6px}",
  };
  pages.forEach((p, i) => {
    files[`OEBPS/page-${i + 1}.xhtml`] = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Page ${i + 1}</title><link rel="stylesheet" href="style.css"/></head><body>${xhtmlBody(p)}</body></html>`;
  });
  return zipWithMimetype("application/epub+zip", files);
}

/** OpenDocument Text (ODT 1.2) with headings, paragraphs, lists and tables. */
export async function toOdt(pages: LayoutPage[], title: string): Promise<Uint8Array> {
  const body = pages
    .map((p) =>
      [
        `<text:h text:outline-level="2">Page ${p.index + 1}</text:h>`,
        ...p.blocks.map((b) => {
          switch (b.type) {
            case "heading":
              return `<text:h text:outline-level="${b.level}">${esc(b.text)}</text:h>`;
            case "paragraph":
              return `<text:p>${esc(b.text)}</text:p>`;
            case "list":
              return `<text:list>${b.items.map((i) => `<text:list-item><text:p>${esc(i)}</text:p></text:list-item>`).join("")}</text:list>`;
            case "table": {
              const cols = b.rows[0]?.length ?? 1;
              return `<table:table table:name="Table${p.index + 1}"><table:table-column table:number-columns-repeated="${cols}"/>${b.rows
                .map((r) => `<table:table-row>${r.map((c) => `<table:table-cell office:value-type="string"><text:p>${esc(c.text)}</text:p></table:table-cell>`).join("")}</table:table-row>`)
                .join("")}</table:table>`;
            }
          }
        }),
      ].join("\n"),
    )
    .join("\n");
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2"><office:automatic-styles/><office:body><office:text><text:h text:outline-level="1">${esc(title)}</text:h>
${body}
</office:text></office:body></office:document-content>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"><office:styles/><office:automatic-styles/><office:master-styles/></office:document-styles>`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
  return zipWithMimetype("application/vnd.oasis.opendocument.text", {
    "META-INF/manifest.xml": manifest,
    "content.xml": content,
    "styles.xml": styles,
  });
}

/** SVG page: embedded page image with invisible but selectable/searchable text positioned on top. */
export function toSvg(page: LayoutPage, png: Uint8Array, title: string): string {
  const W = Math.round(page.width);
  const H = Math.round(page.height);
  const b64 = bytesToBase64(png);
  const texts = page.lines
    .map((l) => `<text x="${l.x.toFixed(2)}" y="${(l.top + l.h * 0.85).toFixed(2)}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.max(1, l.h).toFixed(2)}" fill="#000" fill-opacity="0">${esc(l.text)}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><title>${esc(title)}</title><image x="0" y="0" width="${W}" height="${H}" href="data:image/png;base64,${b64}" xlink:href="data:image/png;base64,${b64}"/>${texts}</svg>\n`;
}

/**
 * Single-page TIFF (uncompressed, 8-bit RGB, chunky, little-endian, one strip) written to the TIFF 6.0
 * baseline specification. Readable by all major viewers and by the validator in validate.ts.
 */
export function toTiff(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const pixels = width * height * 3;
  const rgb = new Uint8Array(pixels);
  for (let i = 0, j = 0; i + 3 < rgba.length && j + 2 < pixels; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  // [tag, type (3 = SHORT, 4 = LONG), count, value]; sorted by tag as the spec requires.
  const entries: [number, number, number, number][] = [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [258, 3, 3, 0],
    [259, 3, 1, 1],
    [262, 3, 1, 2],
    [273, 4, 1, 0],
    [277, 3, 1, 3],
    [278, 4, 1, height],
    [279, 4, 1, pixels],
    [284, 3, 1, 1],
  ];
  const ifdOffset = 8;
  const bpsOffset = ifdOffset + 2 + entries.length * 12 + 4;
  const dataOffset = bpsOffset + 6;
  const out = new Uint8Array(dataOffset + pixels);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, 0x49);
  dv.setUint8(1, 0x49);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdOffset, true);
  dv.setUint16(ifdOffset, entries.length, true);
  entries.forEach(([tag, type, count, value], i) => {
    const o = ifdOffset + 2 + i * 12;
    const v = tag === 258 ? bpsOffset : tag === 273 ? dataOffset : value;
    dv.setUint16(o, tag, true);
    dv.setUint16(o + 2, type, true);
    dv.setUint32(o + 4, count, true);
    if (type === 3 && count === 1) dv.setUint16(o + 8, v, true);
    else dv.setUint32(o + 8, v, true);
  });
  dv.setUint32(ifdOffset + 2 + entries.length * 12, 0);
  dv.setUint16(bpsOffset, 8, true);
  dv.setUint16(bpsOffset + 2, 8, true);
  dv.setUint16(bpsOffset + 4, 8, true);
  out.set(rgb, dataOffset);
  return out;
}
