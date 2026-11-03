export type OcrInputFile = { name: string; kind: "pdf" | "image"; bytes: ArrayBuffer };

/** Read accepted files by position, never by filename (duplicates are common). */
export async function readOcrFiles(files: File[]): Promise<{ accepted: OcrInputFile[]; errors: string[] }> {
  const results = await Promise.all(files.map(async (file): Promise<OcrInputFile | string> => {
    const kind = /\.pdf$/i.test(file.name) || file.type === "application/pdf"
      ? "pdf"
      : /^image\/(png|jpeg)$/.test(file.type) || /\.(png|jpe?g)$/i.test(file.name)
        ? "image"
        : null;
    if (!kind) return `${file.name}: OCR accepts PDF, PNG and JPEG files. Convert other formats to PDF first.`;
    try {
      return { name: file.name, kind, bytes: await file.arrayBuffer() };
    } catch {
      return `${file.name}: Could not read this file. Please try again.`;
    }
  }));
  return {
    accepted: results.filter((item): item is OcrInputFile => typeof item !== "string"),
    errors: results.filter((item): item is string => typeof item === "string"),
  };
}
