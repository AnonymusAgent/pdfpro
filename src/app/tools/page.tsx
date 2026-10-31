import type { Metadata } from "next";
import ToolsPanel from "@/components/tools/ToolsPanel";

export const metadata: Metadata = { title: "Merge, Split & Compress" };

export default function ToolsPage() {
  return <ToolsPanel />;
}
