import type { Metadata } from "next";
import ExtensionPanel from "@/components/support/ExtensionPanel";

export const metadata: Metadata = { title: "Chrome Extension" };

export default function ExtensionPage() {
  return <ExtensionPanel />;
}
