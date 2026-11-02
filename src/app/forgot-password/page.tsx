import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/forms";
import { publicTurnstileSiteKey } from "@/lib/server/config";

export const metadata: Metadata = { title: "Forgot password" };

export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm turnstileSiteKey={publicTurnstileSiteKey()} />;
}
