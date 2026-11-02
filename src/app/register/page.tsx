import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";

export const metadata: Metadata = { title: "Account access" };

export default function RegisterPage() {
  return (
    <AuthShell title="Account access" subtitle="PDF Pro accounts are created by an administrator.">
      <p className="text-sm text-slate-600 dark:text-slate-300">Ask your administrator to add you from their account profile. Already have an account?</p>
      <Link href="/login" className="mt-4 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500">Sign in</Link>
    </AuthShell>
  );
}
