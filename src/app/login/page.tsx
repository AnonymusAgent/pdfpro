import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { googleConfigured, publicTurnstileSiteKey } from "@/lib/server/config";
import { readSession } from "@/lib/server/session";
import { LoginForm } from "@/components/auth/forms";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; reset?: string }>;
}) {
  const params = await searchParams;
  const session = await readSession().catch(() => null);
  const next = params.next && params.next.startsWith("/") && !params.next.startsWith("//") ? params.next : "/dashboard";
  if (session) redirect(next);

  return (
    <LoginForm
      googleEnabled={googleConfigured()}
      next={next}
      oauthError={params.error}
      turnstileSiteKey={publicTurnstileSiteKey()}
    />
  );
}
