import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { sniffKind, verifyOutput } from "@/lib/pdf/validate";

const fixture = (n: string) => new Uint8Array(readFileSync(join(process.cwd(), "tests/fixtures", n)));

describe("output validation", () => {
  it("identifies file types by signature, not by extension", () => {
    expect(sniffKind(new TextEncoder().encode("%PDF-1.7\n"))).toBe("pdf");
    expect(sniffKind(fixture("tiny.png"))).toBe("png");
    expect(sniffKind(fixture("white-letter.jpg"))).toBe("jpeg");
    expect(sniffKind(new TextEncoder().encode("plain text"))).toBe("unknown");
  });

  it("accepts a real PNG and rejects a renamed text file", async () => {
    expect((await verifyOutput("png", fixture("tiny.png"))).ok).toBe(true);
    const fake = await verifyOutput("png", new TextEncoder().encode("this is not an image"));
    expect(fake.ok).toBe(false);
  });

  it("rejects a PDF-named file that is not a PDF", async () => {
    const r = await verifyOutput("pdf", new TextEncoder().encode("Hello, I am not a PDF"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/header/);
  });

  it("rejects a ZIP that is not a Word package (renamed archive)", async () => {
    const zip = new JSZip();
    zip.file("readme.txt", "hello");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const r = await verifyOutput("docx", bytes);
    expect(r.ok).toBe(false);
  });

  it("rejects empty outputs", async () => {
    expect((await verifyOutput("txt", new Uint8Array())).ok).toBe(false);
  });
});
