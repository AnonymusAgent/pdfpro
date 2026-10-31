import type { Metadata } from "next";
import SignSecurity from "@/components/sign/SignSecurity";

export const metadata: Metadata = { title: "Sign & Secure" };

export default function SignPage() {
  return <SignSecurity />;
}
