import { describe, expect, it } from "vitest";
import { pdfChunks } from "@/lib/server/pdf-upload";

const encode = (input: string) => new TextEncoder().encode(input);

async function* pieces(...values: string[]) {
  for (const value of values) yield encode(value);
}

async function contents(...values: string[]): Promise<string> {
  const chunks = await pdfChunks(pieces(...values));
  const found: Uint8Array[] = [];
  for await (const chunk of chunks) found.push(chunk);
  return new TextDecoder().decode(Buffer.concat(found));
}

describe("streamed PDF header validation", () => {
  it("accepts a magic header split across chunks without dropping bytes", async () => {
    expect(await contents("%", "P", "DF-", "1.7\nrest of PDF")).toBe("%PDF-1.7\nrest of PDF");
  });

  it("rejects a short file and a non-PDF", async () => {
    await expect(contents("%PD")).rejects.toMatchObject({ code: "unsupported_type", status: 415 });
    await expect(contents("<svg", " payload")).rejects.toMatchObject({ code: "unsupported_type", status: 415 });
  });
});
