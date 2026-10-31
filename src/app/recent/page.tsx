import type { Metadata } from "next";
import RecentPanel from "@/components/support/RecentPanel";

export const metadata: Metadata = { title: "Recent" };

export default function RecentPage() {
  return <RecentPanel />;
}
