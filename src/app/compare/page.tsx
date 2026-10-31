import type { Metadata } from "next";
import Compare from "@/components/compare/Compare";

export const metadata: Metadata = { title: "Compare PDFs" };

export default function ComparePage() {
  return <Compare />;
}
