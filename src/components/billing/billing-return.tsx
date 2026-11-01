"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useSession } from "@/components/auth/session-provider";
import { Card, Notice } from "@/components/ui";

const POLL_INTERVAL_MS = 4000;
const MAX_POLLS = 15;

/**
 * Landing page after Safepay checkout.
 *
 * The page never decides that a payment succeeded. It asks the server, which
 * verifies the redirect signature and queries Safepay directly; Premium is only
 * granted by that verified path. While the confirmation is in flight the page
 * polls, because webhooks can arrive a few seconds after the redirect.
 */
export function BillingReturnPanel({
  paymentId,
  tracker,
  signature,
  cancelled,
}: {
  paymentId: string;
  tracker: string | null;
  signature: string | null;
  cancelled: boolean;
}) {
  const { refresh } = useSession();
  const [state, setState] = useState<"checking" | "paid" | "pending" | "failed" | "no-payment">(
    cancelled ? "failed" : paymentId ? "checking" : "no-payment",
  );
  const [message, setMessage] = useState<string | null>(
    cancelled ? "Checkout was cancelled. No payment was taken and no subscription was started." : null,
  );
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    if (cancelled || !paymentId) return;
    let active = true;
    let polls = 0;

    const check = async () => {
      polls += 1;
      if (active) setAttempts(polls);
      try {
        const response = await fetch("/api/billing/verify-return", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paymentId, tracker, signature }),
        });
        const data = (await response.json().catch(() => ({}))) as { status?: string; message?: string; error?: string };
        if (!active) return;
        if (data.status === "paid") {
          setState("paid");
          setMessage(data.message ?? "Payment confirmed. Premium is active.");
          await refresh();
          return;
        }
        if (data.status === "failed") {
          setState("failed");
          setMessage(data.message ?? "The payment was not completed.");
          return;
        }
        setState("pending");
        setMessage(data.message ?? "Waiting for the payment confirmation…");
        if (polls < MAX_POLLS) setTimeout(() => void check(), POLL_INTERVAL_MS);
      } catch {
        if (active) setState("pending");
      }
    };

    void check();
    return () => {
      active = false;
    };
  }, [paymentId, tracker, signature, cancelled, refresh]);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12">
      <Card title={state === "paid" ? "Payment confirmed" : cancelled ? "Checkout cancelled" : "Confirming your payment"}>
        <div className="space-y-4 text-sm">
          {state === "paid" ? (
            <p className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 size={18} aria-hidden /> <strong>{message}</strong>
            </p>
          ) : state === "failed" ? (
            <p className="flex items-center gap-2 text-red-700 dark:text-red-300">
              <XCircle size={18} aria-hidden /> <strong>{message}</strong>
            </p>
          ) : state === "no-payment" ? (
            <Notice tone="warn">This page needs a payment reference. Start from the pricing page.</Notice>
          ) : (
            <p className="flex items-center gap-2 text-slate-700 dark:text-slate-200">
              <Loader2 size={18} className="animate-spin" aria-hidden />
              <span>
                {message ?? "Verifying with Safepay…"}
                {attempts > 1 && <span className="text-xs text-slate-500"> (check {attempts})</span>}
              </span>
            </p>
          )}

          <p className="text-xs text-slate-500 dark:text-slate-400">
            Premium is activated only after the payment is verified on our server. If this page keeps waiting, the
            confirmation may still arrive by webhook — your dashboard and payment history will update automatically.
          </p>

          <div className="flex flex-wrap gap-2">
            <Link href="/dashboard" className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500">
              Go to dashboard
            </Link>
            <Link href="/account?tab=billing" className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-100">
              Payment history
            </Link>
            <Link href="/pricing" className="rounded-lg px-3 py-2 text-xs font-semibold text-blue-700 hover:underline dark:text-blue-300">
              Back to pricing
            </Link>
          </div>
        </div>
      </Card>
    </div>
  );
}
