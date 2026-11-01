import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/forms";

export const metadata: Metadata = { title: "Reset password" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  return <ResetPasswordForm token={token} valid={Boolean(token) && token.length < 200} />;
}
