import { describe, expect, it } from "vitest";
import { boxToDisplay, displaySize, normRot, toDisplay, toPage } from "@/lib/pdf/geometry";

describe("rotation geometry", () => {
  it("normalizes angles to 0/90/180/270", () => {
    expect(normRot(-90)).toBe(270);
    expect(normRot(450)).toBe(90);
    expect(normRot(360)).toBe(0);
    expect(normRot(0)).toBe(0);
  });

  it("swaps display dimensions for quarter turns", () => {
    expect(displaySize(612, 792, 0)).toEqual({ w: 612, h: 792 });
    expect(displaySize(612, 792, 90)).toEqual({ w: 792, h: 612 });
    expect(displaySize(612, 792, 180)).toEqual({ w: 612, h: 792 });
  });

  it("maps the page top-left corner to the expected displayed corner", () => {
    expect(toDisplay({ x: 0, y: 0 }, 0)).toEqual({ x: 0, y: 0 });
    expect(toDisplay({ x: 0, y: 0 }, 90)).toEqual({ x: 1, y: 0 });
    expect(toDisplay({ x: 0, y: 0 }, 180)).toEqual({ x: 1, y: 1 });
    expect(toDisplay({ x: 0, y: 0 }, 270)).toEqual({ x: 0, y: 1 });
  });

  it("toPage is the exact inverse of toDisplay for every rotation", () => {
    const points = [
      { x: 0.1, y: 0.2 },
      { x: 0.75, y: 0.4 },
      { x: 0.5, y: 0.95 },
    ];
    for (const r of [0, 90, 180, 270] as const) {
      for (const p of points) {
        const back = toPage(toDisplay(p, r), r);
        expect(back.x).toBeCloseTo(p.x, 10);
        expect(back.y).toBeCloseTo(p.y, 10);
      }
    }
  });

  it("keeps a box's displayed bounding box inside the unit square", () => {
    for (const r of [0, 90, 180, 270] as const) {
      const b = boxToDisplay({ x: 0.2, y: 0.1, w: 0.3, h: 0.05 }, r);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(b.y + b.h).toBeLessThanOrEqual(1 + 1e-9);
      expect(b.w * b.h).toBeCloseTo(0.3 * 0.05, 10);
    }
  });
});
