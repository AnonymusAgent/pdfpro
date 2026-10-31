#!/usr/bin/env node
/*
 * Copies offline runtime assets into /public and generates the extension icons.
 * Run once after `npm install` (and again after upgrading pdfjs-dist or tesseract.js):
 *   node scripts/setup-assets.mjs
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

const root = process.cwd();

function copy(from, to) {
  const src = join(root, from);
  const dst = join(root, to);
  if (!existsSync(src)) {
    console.warn(`[assets] missing ${from} (skipped)`);
    return false;
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`[assets] ${to}`);
  return true;
}

// PDF.js worker (legacy build matches the legacy import used by the app).
copy("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs", "public/vendor/pdf.worker.min.mjs");

// Tesseract.js worker + WebAssembly core (SIMD and non-SIMD builds).
copy("node_modules/tesseract.js/dist/worker.min.js", "public/vendor/tesseract/worker.min.js");
// Tesseract.js selects the core by detected WebAssembly features (relaxed-SIMD, SIMD, or plain), so all three LSTM builds are needed.
for (const f of [
  "tesseract-core-relaxedsimd-lstm.wasm.js",
  "tesseract-core-relaxedsimd-lstm.wasm",
  "tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm",
  "tesseract-core-lstm.wasm.js",
  "tesseract-core-lstm.wasm",
]) {
  copy(`node_modules/tesseract.js-core/${f}`, `public/vendor/tesseract/${f}`);
}

// English trained data (fast, best-integer model) — other languages are fetched on demand from the CDN.
copy(
  "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
  "public/vendor/tessdata/eng.traineddata.gz",
);

// ---- extension icons (PNG, required by Chrome; SVG is not accepted in manifest icons) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size, y / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// Design: navy rounded square, white page with a red header band and blue text lines.
function iconPixel(u, v) {
  const inRound = (() => {
    const r = 0.18;
    const cx = Math.min(Math.max(u, r), 1 - r);
    const cy = Math.min(Math.max(v, r), 1 - r);
    return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
  })();
  if (!inRound) return [0, 0, 0, 0];
  const page = u > 0.25 && u < 0.75 && v > 0.14 && v < 0.86;
  if (!page) return [12, 29, 51, 255];
  if (v < 0.32) return [220, 38, 38, 255];
  const line = (v > 0.42 && v < 0.47) || (v > 0.56 && v < 0.61) || (v > 0.70 && v < 0.75);
  if (line && u > 0.31 && u < 0.69) return [37, 99, 235, 255];
  return [255, 255, 255, 255];
}

for (const size of [16, 48, 128]) {
  const out = join(root, `public/extension/icons/icon${size}.png`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, encodePng(size, iconPixel));
  console.log(`[assets] public/extension/icons/icon${size}.png`);
}
