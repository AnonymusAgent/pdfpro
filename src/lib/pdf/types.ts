/**
 * Shared document-model types for PDF Pro.
 *
 * Coordinate system: every annotation is stored in NORMALIZED page space of the
 * UNROTATED source page view (0..1, origin top-left). Page rotation is applied only
 * for display (CSS/canvas) and by the exporter via /Rotate. This keeps annotations
 * attached to page content when pages are rotated, reordered, or re-exported.
 */

export type Box = { x: number; y: number; w: number; h: number };
export type Pt = { x: number; y: number };

export type FontFamily = "helvetica" | "times" | "courier";

export type AnnType =
  | "highlight"
  | "underline"
  | "strike"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "draw"
  | "text"
  | "note"
  | "stamp"
  | "redact"
  | "whiteout"
  | "replace"
  | "image"
  | "signature"
  | "link"
  | "field";

/** One page instance in the editor. Duplicated pages get new uids, so their annotations stay independent. */
export type PageEntry = {
  uid: string;
  /** Source id: "main" for the opened file, or the id of an inserted source, or "blank". */
  src: string;
  /** 0-based page index inside the source document (-1 for blank pages). */
  index: number;
  /** Extra user rotation in degrees, multiple of 90, added to the page's own /Rotate. */
  rot: number;
  /** Crop box in normalized, unrotated page space, or null for the full page. */
  crop: Box | null;
  blankW?: number;
  blankH?: number;
};

export type Ann = {
  id: string;
  /** Owning PageEntry.uid */
  uid: string;
  type: AnnType;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  url?: string;
  color: string;
  fill?: string | null;
  opacity: number;
  /** Font size in points (1 pt == 1 px at 100% zoom). */
  fontSize: number;
  font?: FontFamily;
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right";
  strokeWidth?: number;
  /** Freehand points, normalized, unrotated page space. */
  points?: Pt[];
  /** Clockwise rotation in degrees for images and signatures. */
  rotation?: number;
  /** PNG or JPEG data URL for images and signatures. */
  dataUrl?: string;
  /** Natural width/height ratio of the image. */
  aspect?: number;
  /** Original text covered by a "replace" overlay. */
  original?: string;
  fieldName?: string;
};

export type EditState = { pages: PageEntry[]; anns: Ann[] };

export type SourceInfo = { id: string; name: string; bytes: ArrayBuffer };

/** Paper sizes in PDF points (portrait). */
export const PAPER_SIZES: Record<string, [number, number]> = {
  A4: [595.28, 841.89],
  A3: [841.89, 1190.55],
  Letter: [612, 792],
  Legal: [612, 1008],
};

export function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function initialEdit(pageCount: number, src = "main"): EditState {
  return {
    pages: Array.from({ length: pageCount }, (_, i) => ({ uid: uid(), src, index: i, rot: 0, crop: null })),
    anns: [],
  };
}
