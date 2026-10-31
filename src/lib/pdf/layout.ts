/**
 * Layout analysis for PDF-to-document conversion.
 *
 * Input: positioned text items (top-down coordinates, in points).
 * Output: reading-ordered blocks — headings, paragraphs, lists and tables.
 *
 * Heuristic by design: it works well for single-column reports, forms and typical
 * tables. Multi-column magazine layouts and tables without ruling/alignment are
 * best-effort and must be reviewed. Pure functions, no PDF or DOM dependency.
 */

export type LayoutItem = { str: string; x: number; y: number; w: number; h: number };

type Segment = { x: number; w: number; text: string };

export type TextLine = {
  top: number;
  bottom: number;
  x: number;
  right: number;
  h: number;
  text: string;
  segments: Segment[];
};

export type TableCell = { text: string; numeric: boolean };

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string; top: number }
  | { type: "paragraph"; text: string; top: number }
  | { type: "list"; items: string[]; top: number }
  | { type: "table"; rows: TableCell[][]; top: number };

export type LayoutPage = {
  index: number;
  width: number;
  height: number;
  blocks: Block[];
  /** Plain positioned lines, used for selectable SVG text and debugging. */
  lines: { text: string; x: number; top: number; h: number }[];
};

const BULLET = /^\s*([•●▪◦·\-*–]|\(?\d{1,3}[.)]|[a-zA-Z][.)])\s+/;

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
}

/** Parses "1,234.50", "$12", "(45)", "12%", "-3.4" as numbers; returns null otherwise. */
export function parseNumber(input: string): number | null {
  const t = input.trim().replace(/[$€£¥\s]/g, "").replace(/%$/, "");
  if (!t) return null;
  const negative = /^\(.*\)$/.test(t);
  const core = t.replace(/[()]/g, "").replace(/,(?=\d{3}(\D|$))/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(core)) return null;
  const n = Number(core);
  return negative ? -Math.abs(n) : n;
}

/** Groups positioned items into visual lines, splitting segments at wide column gaps. */
export function buildLines(items: LayoutItem[]): TextLine[] {
  const usable = items.filter((i) => i.str.trim().length > 0 && Number.isFinite(i.x) && Number.isFinite(i.y));
  usable.sort((a, b) => a.y - b.y || a.x - b.x);
  type Group = { items: LayoutItem[]; cy: number };
  const groups: Group[] = [];
  for (const it of usable) {
    const cy = it.y + it.h / 2;
    const g = groups[groups.length - 1];
    const tol = Math.max(0.5, Math.min(it.h, g ? median(g.items.map((i) => i.h)) : it.h) * 0.5);
    if (g && Math.abs(cy - g.cy) <= tol) {
      g.items.push(it);
    } else {
      groups.push({ items: [it], cy });
    }
  }
  return groups.map((g) => {
    const items2 = [...g.items].sort((a, b) => a.x - b.x);
    const segments: Segment[] = [];
    let cur: Segment | null = null;
    let prevEnd = 0;
    let prevH = 0;
    for (const it of items2) {
      const h = Math.max(it.h, 1);
      const gap = cur ? it.x - prevEnd : 0;
      if (!cur || gap > 1.2 * Math.max(h, prevH)) {
        if (cur) segments.push(cur);
        cur = { x: it.x, w: it.w, text: it.str };
      } else {
        cur.text += (gap > 0.12 * h ? " " : "") + it.str;
        cur.w = it.x + it.w - cur.x;
      }
      prevEnd = it.x + it.w;
      prevH = h;
    }
    if (cur) segments.push(cur);
    const top = Math.min(...items2.map((i) => i.y));
    const bottom = Math.max(...items2.map((i) => i.y + i.h));
    const x = Math.min(...items2.map((i) => i.x));
    const right = Math.max(...items2.map((i) => i.x + i.w));
    const text = segments
      .map((s) => s.text.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return { top, bottom, x, right, h: median(items2.map((i) => i.h)), text, segments };
  });
}

function buildTable(group: TextLine[], bodyH: number): Block | null {
  if (group.length < 2) return null;
  const xs = group.flatMap((l) => l.segments.map((s) => s.x)).sort((a, b) => a - b);
  const tol = Math.max(6, 1.2 * bodyH);
  const clusters: number[][] = [];
  let cluster: number[] = [];
  for (const x of xs) {
    if (cluster.length && x - cluster[cluster.length - 1] > tol) {
      clusters.push(cluster);
      cluster = [];
    }
    cluster.push(x);
  }
  if (cluster.length) clusters.push(cluster);
  const centers = clusters.map(mean);
  if (centers.length < 2) return null;

  const grid: string[][] = group.map((line) => {
    const cells: string[] = new Array(centers.length).fill("");
    for (const seg of line.segments) {
      let best = 0;
      for (let c = 1; c < centers.length; c++) {
        if (Math.abs(seg.x - centers[c]) < Math.abs(seg.x - centers[best])) best = c;
      }
      const t = seg.text.trim();
      cells[best] = cells[best] ? `${cells[best]} ${t}` : t;
    }
    return cells;
  });
  const filledRows = grid.filter((r) => r.filter((c) => c.trim()).length >= 2).length;
  if (filledRows / grid.length < 0.6) return null;

  // Drop columns that are empty in every row.
  const keep = centers.map((_, c) => grid.some((r) => r[c].trim() !== "")).map((k, c) => (k ? c : -1)).filter((c) => c >= 0);
  if (keep.length < 2) return null;
  const rows: TableCell[][] = grid.map((r) =>
    keep.map((c) => {
      const text = r[c].trim();
      return { text, numeric: parseNumber(text) !== null && text !== "" };
    }),
  );
  return { type: "table", rows, top: group[0].top };
}

/** Detects tables first, then groups remaining lines into headings, lists and paragraphs. */
export function detectBlocks(lines: TextLine[]): Block[] {
  if (!lines.length) return [];
  const bodyH = median(lines.map((l) => l.h)) || 10;
  const used = new Array<boolean>(lines.length).fill(false);
  const tables: Block[] = [];

  let i = 0;
  while (i < lines.length) {
    if (lines[i].segments.length < 2) {
      i++;
      continue;
    }
    let j = i;
    while (
      j < lines.length &&
      lines[j].segments.length >= 2 &&
      (j === i || lines[j].top - lines[j - 1].bottom <= 1.2 * bodyH)
    ) {
      j++;
    }
    const table = buildTable(lines.slice(i, j), bodyH);
    if (table) {
      tables.push(table);
      for (let k = i; k < j; k++) used[k] = true;
    }
    i = j;
  }

  const blocks: Block[] = [];
  let para: { text: string; top: number; bottom: number } | null = null;
  let list: { items: string[]; top: number; bottom: number } | null = null;
  const flushPara = () => {
    if (para && para.text.trim()) blocks.push({ type: "paragraph", text: para.text.trim(), top: para.top });
    para = null;
  };
  const flushList = () => {
    if (list && list.items.length) blocks.push({ type: "list", items: list.items, top: list.top });
    list = null;
  };

  for (let k = 0; k < lines.length; k++) {
    if (used[k]) {
      flushPara();
      flushList();
      continue;
    }
    const l = lines[k];
    const text = l.text;
    if (!text) continue;
    const isBullet = BULLET.test(text);
    if (l.h >= 1.25 * bodyH && text.length <= 140 && !isBullet) {
      flushPara();
      flushList();
      const ratio = l.h / bodyH;
      blocks.push({ type: "heading", level: ratio >= 2 ? 1 : ratio >= 1.5 ? 2 : 3, text, top: l.top });
      continue;
    }
    if (isBullet) {
      flushPara();
      if (!list || l.top - list.bottom > 1.8 * bodyH) {
        flushList();
        list = { items: [], top: l.top, bottom: l.bottom };
      }
      list.items.push(text.replace(BULLET, "").trim());
      list.bottom = l.bottom;
      continue;
    }
    flushList();
    if (para && l.top - para.bottom <= 0.9 * bodyH) {
      const p: { text: string; top: number; bottom: number } = para;
      p.text = p.text.endsWith("-") && /^[a-z]/.test(text) ? p.text.slice(0, -1) + text : `${p.text} ${text}`;
      p.bottom = l.bottom;
    } else {
      flushPara();
      para = { text, top: l.top, bottom: l.bottom };
    }
  }
  flushPara();
  flushList();
  return [...blocks, ...tables].sort((a, b) => a.top - b.top);
}

export function layoutPage(index: number, width: number, height: number, items: LayoutItem[]): LayoutPage {
  const lines = buildLines(items);
  return {
    index,
    width,
    height,
    blocks: detectBlocks(lines),
    lines: lines.map((l) => ({ text: l.text, x: l.x, top: l.top, h: l.h })),
  };
}
