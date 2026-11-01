#!/usr/bin/env node
/**
 * Synthetic test fixtures.
 *
 * The unit and end-to-end tests read small documents from `tests/fixtures`.
 * They are generated rather than committed so the repository stays free of
 * binary blobs and every file is reproducible:
 *
 *   npm run fixtures
 *
 * Produces:
 *   tiny.png         8×8 PNG used for signature sniffing and embedding
 *   sample-scan.png  900×300 PNG that looks like a scanned page (OCR input)
 *   white-letter.jpg 612×792 baseline grayscale JPEG (raster page image)
 *   sample-report.pdf two-page PDF with headings, paragraphs and a table
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";

const outDir = join(process.cwd(), "tests", "fixtures");
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** Encodes an 8-bit grayscale raster (array of rows) as a PNG. */
function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      raw[y * (width + 1) + 1 + x] = pixel(x, y);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Minimal baseline JPEG encoder for a mid-gray single-component image.
 * Uses custom one-symbol Huffman tables (legal, tiny) and all-zero
 * coefficients, so the entropy-coded stream is two bits per 8×8 block.
 */
function encodeGrayJpeg(width, height) {
  const tables = Buffer.concat([
    // DQT, table 0, 8-bit, 64 coefficients all 1
    Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(1)]),
    // SOF0: 8-bit, height, width, 1 component, sampling 1×1, quant table 0
    Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00]),
    // DHT DC table 0: one code of length 1 → symbol 0
    Buffer.from([0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    // DHT AC table 0: one code of length 1 → symbol 0 (EOB)
    Buffer.from([0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    // SOS: 1 component, DC/AC table 0
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
  ]);

  const blocksX = Math.ceil(width / 8);
  const blocksY = Math.ceil(height / 8);
  const totalBlocks = blocksX * blocksY;

  // Two bits per block ("0" DC category 0, "0" AC EOB), padded with 1s.
  const bits = totalBlocks * 2;
  const byteCount = Math.ceil(bits / 8);
  const scan = [];
  let current = 0;
  let used = 0;
  for (let i = 0; i < byteCount; i += 1) {
    current = 0xff; // remaining padding bits are 1s
    used = Math.min(8, bits - i * 8);
    current = (0xff << used) & 0xff;
    scan.push(current);
  }
  // Byte stuffing so 0xFF never appears inside entropy-coded data.
  const stuffed = [];
  for (const byte of scan) {
    stuffed.push(byte);
    if (byte === 0xff) stuffed.push(0x00);
  }

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    tables,
    Buffer.from(stuffed),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function makeScanPage() {
  const width = 900;
  const height = 300;
  // Bars act as text lines (dark "words" on a light page) for OCR pipelines.
  const lines = [
    { top: 40, left: 60, width: 520, thickness: 26 },
    { top: 92, left: 60, width: 700, thickness: 18 },
    { top: 128, left: 60, width: 640, thickness: 18 },
    { top: 164, left: 60, width: 380, thickness: 18 },
    { top: 216, left: 60, width: 240, thickness: 22 },
  ];
  return encodePng(width, height, (x, y) => {
    for (const line of lines) {
      if (y >= line.top && y < line.top + line.thickness && x >= line.left && x < line.left + line.width) {
        // Broken segments so the result reads like words rather than a bar.
        return (x - line.left) % 34 < 26 ? 20 : 250;
      }
    }
    return 250;
  });
}

async function makeReportPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const page = pdf.addPage([595, 842]);
  page.drawText("Quarterly Revenue Report", { x: 60, y: 770, size: 22, font: bold, color: rgb(0.05, 0.11, 0.2) });
  page.drawText("Prepared by PDF Pro sample data", { x: 60, y: 745, size: 11, font, color: rgb(0.4, 0.45, 0.5) });
  page.drawText("Revenue grew across every region this quarter, with the strongest", { x: 60, y: 700, size: 12, font });
  page.drawText("performance in cloud storage subscriptions and annual plans.", { x: 60, y: 682, size: 12, font });

  const rows = [
    ["Region", "Revenue", "Growth"],
    ["North", "120000", "12%"],
    ["South", "98000", "9%"],
    ["East", "143500", "18%"],
    ["West", "76500", "4%"],
  ];
  let y = 640;
  for (const [index, row] of rows.entries()) {
    page.drawText(row[0], { x: 60, y, size: 12, font: index === 0 ? bold : font });
    page.drawText(row[1], { x: 260, y, size: 12, font: index === 0 ? bold : font });
    page.drawText(row[2], { x: 420, y, size: 12, font: index === 0 ? bold : font });
    y -= 24;
  }

  const second = pdf.addPage([595, 842]);
  second.drawText("Notes", { x: 60, y: 770, size: 18, font: bold });
  second.drawText("Figures are synthetic and used for automated PDF Pro tests.", { x: 60, y: 740, size: 12, font });
  second.drawText("Search for the word revenue to verify text extraction.", { x: 60, y: 720, size: 12, font });

  return Buffer.from(await pdf.save());
}

await mkdir(outDir, { recursive: true });

await writeFile(join(outDir, "tiny.png"), encodePng(8, 8, (x, y) => (x + y) % 2 === 0 ? 255 : 240));
await writeFile(join(outDir, "sample-scan.png"), makeScanPage());
await writeFile(join(outDir, "white-letter.jpg"), encodeGrayJpeg(612, 792));
await writeFile(join(outDir, "sample-report.pdf"), await makeReportPdf());

console.log(`[fixtures] wrote tiny.png, sample-scan.png, white-letter.jpg, sample-report.pdf to ${outDir}`);
