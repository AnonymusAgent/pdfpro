import type { Metadata } from "next";
import OcrWorkspace from "@/components/ocr/OcrWorkspace";

export const metadata: Metadata = { title: "OCR" };

export default function OcrPage() {
  return <OcrWorkspace />;
}
