import type { Metadata } from "next";
import { VerifyEmailPanel } from "@/components/auth/forms";

export const metadata: Metadata = { title: "Verify email" };

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const params = await searchParams;
  const token = typeof params.token === "string" && params.token.length < 200 ? params.token : null;
  return <VerifyEmailPanel token={token} />;
}
