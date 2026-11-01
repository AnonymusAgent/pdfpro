import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { googleConfigured } from "@/lib/server/config";
import { readSession } from "@/lib/server/session";
import { RegisterForm } from "@/components/auth/forms";

export const metadata: Metadata = { title: "Create an account" };
export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const session = await readSession().catch(() => null);
  if (session) redirect("/dashboard");
  return <RegisterForm googleEnabled={googleConfigured()} />;
}
