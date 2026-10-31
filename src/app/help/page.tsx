import type { Metadata } from "next";
import HelpPanel from "@/components/support/HelpPanel";

export const metadata: Metadata = { title: "Help & Shortcuts" };

export default function HelpPage() {
  return <HelpPanel />;
}
