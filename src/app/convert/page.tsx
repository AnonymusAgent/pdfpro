import type { Metadata } from "next";
import ConvertCenter from "@/components/convert/ConvertCenter";

export const metadata: Metadata = { title: "Convert" };

export default function ConvertPage() {
  return <ConvertCenter />;
}
