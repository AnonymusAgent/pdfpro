"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { useSession } from "@/components/auth/session-provider";

/**
 * Starts a real Safepay checkout.
 *
 * The server creates the payment session and returns the hosted checkout URL.
 * Nothing here can grant Premium: activation only happens after a verified
 * webhook or a server-to-server payment lookup.
 */
export function PlanCheckoutButton({
  planId,
  planName,
  label,
  variant = "primary",
  available,
  unavailableReason,
  signedIn,
  emailVerified,
}: {
  planId: string;
  planName: string;
  label: string;
  variant?: "primary" | "secondary";
  available: boolean;
  unavailableReason: string | null;
  signedIn: boolean;
  emailVerified: boolean;
}) {
  const router = useRouter();
  const { refresh } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base =
    variant === "primary"
      ? "bg-blue-600 text-white hover:bg-blue-500"
      : "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100";

  if (!signedIn) {
    return (
      <Link
        href={`/register?next=${encodeURIComponent("/pricing")}`}
        className={`flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold ${base}`}
      >
        Create an account to subscribe
      </Link>
    );
  }

  if (!emailVerified) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          disabled
          className={`flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold opacity-60 ${base}`}
        >
          Verify your email to subscribe
        </button>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          Open the verification email we sent you, then come back to this page.
        </p>
      </div>
    );
  }

  if (!available) {
    return (
      <div className="space-y-1">
        <button
          type="button"
          disabled
          className={`flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold opacity-60 ${base}`}
        >
          <Lock size={14} aria-hidden /> Checkout not open yet
        </button>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          {unavailableReason ?? "Card payments are not configured on this deployment."}
        </p>
      </div>
    );
  }

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      const data = (await response.json().catch(() => ({}))) as { redirectUrl?: string; error?: string };
      if (!response.ok || !data.redirectUrl) {
        setError(data.error ?? "Could not start checkout.");
        return;
      }
      await refresh();
      window.location.assign(data.redirectUrl);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void start()}
        disabled={busy}
        aria-label={`${label} — ${planName}`}
        className={`flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold disabled:opacity-60 ${base}`}
      >
        {busy && <Loader2 size={15} className="animate-spin" aria-hidden />}
        {label}
      </button>
      {error && <p role="alert" className="text-xs font-semibold text-red-600 dark:text-red-400">{error}</p>}
      <p className="text-[11px] text-slate-500 dark:text-slate-400">
        Secure checkout on Safepay. Card details never touch PDF Pro.
      </p>
      <button
        type="button"
        onClick={() => router.push("/account?tab=billing")}
        className="text-[11px] text-slate-500 underline hover:text-slate-700 dark:text-slate-400"
      >
        View payment history
      </button>
    </div>
  );
}
