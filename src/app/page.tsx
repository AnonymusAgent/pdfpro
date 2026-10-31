import type { Metadata } from "next";
import Dashboard from "@/components/dashboard/Dashboard";

export const metadata: Metadata = {
  title: "PDF Pro — Editor, Converter & OCR",
};

export default function HomePage() {
  return <Dashboard />;
}
