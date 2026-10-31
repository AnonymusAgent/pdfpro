import { describe, expect, it } from "vitest";
import { buildLines, detectBlocks, layoutPage, parseNumber, type LayoutItem } from "@/lib/pdf/layout";

function item(str: string, x: number, y: number, w: number, h = 11): LayoutItem {
  return { str, x, y, w, h };
}

describe("parseNumber", () => {
  it("parses formatted numbers used in financial tables", () => {
    expect(parseNumber("$1,234.50")).toBe(1234.5);
    expect(parseNumber("(12)")).toBe(-12);
    expect(parseNumber("12%")).toBe(12);
    expect(parseNumber("-3.4")).toBe(-3.4);
    expect(parseNumber("North")).toBeNull();
    expect(parseNumber("")).toBeNull();
  });
});

describe("layout analysis", () => {
  it("groups items into lines and splits wide gaps into segments", () => {
    const lines = buildLines([item("Region", 50, 220, 40), item("Q1", 200, 220, 20), item("Q2", 350, 220, 20)]);
    expect(lines).toHaveLength(1);
    expect(lines[0].segments.map((s) => s.text)).toEqual(["Region", "Q1", "Q2"]);
  });

  it("detects a heading, a paragraph, a list and a table in reading order", () => {
    const items: LayoutItem[] = [
      item("Quarterly", 50, 40, 150, 24),
      item("Report", 210, 40, 120, 24),
      item("This is the first line of", 50, 100, 300),
      item("the body paragraph.", 50, 116, 200),
      item("• Alpha item", 50, 150, 100),
      item("• Beta item", 50, 166, 100),
      item("Region", 50, 220, 40),
      item("Q1", 200, 220, 20),
      item("Q2", 350, 220, 20),
      item("North", 50, 240, 40),
      item("100", 200, 240, 20),
      item("120", 350, 240, 20),
      item("South", 50, 260, 40),
      item("90", 200, 260, 20),
      item("110", 350, 260, 20),
    ];
    const page = layoutPage(0, 612, 792, items);
    const types = page.blocks.map((b) => b.type);
    expect(types).toEqual(["heading", "paragraph", "list", "table"]);

    const heading = page.blocks[0];
    expect(heading.type === "heading" && heading.text).toBe("Quarterly Report");
    expect(heading.type === "heading" && heading.level).toBe(1);

    const para = page.blocks[1];
    expect(para.type === "paragraph" && para.text).toBe("This is the first line of the body paragraph.");

    const list = page.blocks[2];
    expect(list.type === "list" && list.items).toEqual(["Alpha item", "Beta item"]);

    const table = page.blocks[3];
    expect(table.type).toBe("table");
    if (table.type !== "table") throw new Error("expected table");
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0].map((c) => c.text)).toEqual(["Region", "Q1", "Q2"]);
    expect(table.rows[1][1]).toEqual({ text: "100", numeric: true });
    expect(table.rows[2][2].text).toBe("110");
  });

  it("does not invent a table from a single aligned line", () => {
    const page = layoutPage(0, 612, 792, [item("Total", 50, 300, 40), item("42", 400, 300, 20)]);
    expect(page.blocks.some((b) => b.type === "table")).toBe(false);
  });
});
