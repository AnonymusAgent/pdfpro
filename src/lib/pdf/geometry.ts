import type { Box, Pt } from "./types";

export type Rot = 0 | 90 | 180 | 270;

/** Normalize any angle to 0 | 90 | 180 | 270 (clockwise). */
export function normRot(deg: number): Rot {
  const snapped = Math.round(deg / 90) * 90;
  return ((((snapped % 360) + 360) % 360) as Rot);
}

/** Displayed size of a W×H page rotated clockwise by r. */
export function displaySize(W: number, H: number, r: Rot): { w: number; h: number } {
  return r === 90 || r === 270 ? { w: H, h: W } : { w: W, h: H };
}

/**
 * Page space (unrotated, normalized, top-left origin) -> displayed space after a clockwise
 * rotation by r. Verified by corner mapping: the page top-left corner moves to the top-right
 * for 90°, bottom-right for 180°, bottom-left for 270°.
 */
export function toDisplay(p: Pt, r: Rot): Pt {
  const { x: u, y: v } = p;
  switch (r) {
    case 90:
      return { x: 1 - v, y: u };
    case 180:
      return { x: 1 - u, y: 1 - v };
    case 270:
      return { x: v, y: 1 - u };
    default:
      return { x: u, y: v };
  }
}

/** Inverse of toDisplay: displayed normalized point -> page space. */
export function toPage(p: Pt, r: Rot): Pt {
  const { x: a, y: b } = p;
  switch (r) {
    case 90:
      return { x: b, y: 1 - a };
    case 180:
      return { x: 1 - a, y: 1 - b };
    case 270:
      return { x: 1 - b, y: a };
    default:
      return { x: a, y: b };
  }
}

/** Axis-aligned bounding box of a page-space box after rotation. */
export function boxToDisplay(box: Box, r: Rot): Box {
  const corners = [
    toDisplay({ x: box.x, y: box.y }, r),
    toDisplay({ x: box.x + box.w, y: box.y }, r),
    toDisplay({ x: box.x, y: box.y + box.h }, r),
    toDisplay({ x: box.x + box.w, y: box.y + box.h }, r),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function clamp(v: number, lo = 0, hi = 1): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Build a normalized box from two arbitrary corner points. */
export function boxFromPoints(a: Pt, b: Pt): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
