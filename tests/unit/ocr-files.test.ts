import { describe, expect, it } from "vitest";
import { readOcrFiles } from "@/lib/pdf/ocr-files";

function mockFile(name: string, type: string, payload: string): File {
  return {
    name, type,
    arrayBuffer: async () => new TextEncoder().encode(payload).buffer,
  } as File;
}

describe("OCR file staging", () => {
  it("keeps distinct bytes for files that share a name and preserves selection order", async () => {
    const first = mockFile("scan.pdf", "application/pdf", "first PDF");
    const second = mockFile("scan.pdf", "application/pdf", "second PDF");
    const result = await readOcrFiles([first, second]);
    expect(result.errors).toEqual([]);
    expect(result.accepted.map((file) => new TextDecoder().decode(file.bytes))).toEqual(["first PDF", "second PDF"]);
  });

  it("does not read unsupported formats and reports file read failures", async () => {
    const unsupported = mockFile("note.txt", "text/plain", "not loaded");
    const broken = { ...mockFile("bad.png", "image/png", ""), arrayBuffer: async () => { throw Error("read failed"); } } as File;
    const result = await readOcrFiles([unsupported, broken, mockFile("ok.jpg", "image/jpeg", "image")]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.name).toBe("ok.jpg");
    expect(result.errors).toHaveLength(2);
  });
});
