"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "@/components/auth/session-provider";
import { getAdConsent, setAdConsent } from "@/components/ads/ad-slot";

/**
 * Advertising consent notice.
 *
 * Only shown to Free accounts when advertising is actually configured and the
 * administrator requires consent. Stored on the device; no network call is made
 * until the visitor accepts.
 */
export function ConsentBanner() {
  const { premium } = useSession();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (premium) return;
    let active = true;
    fetch("/api/site-config", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { ads?: { enabled: boolean; requireConsent: boolean } } | null) => {
        if (!active) return;
        const ads = data?.ads;
        if (ads?.enabled && ads.requireConsent && getAdConsent() === "unset") setVisible(true);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [premium]);

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Advertising consent"
      className="fixed inset-x-3 bottom-3 z-[120] mx-auto max-w-2xl rounded-xl border border-slate-300 bg-white p-4 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
    >
      <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Advertising and privacy</p>
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
        Free accounts may see Google AdSense advertising, which uses cookies to personalise ads. Premium accounts never
        see ads. Choose whether to allow personalised advertising — the PDF tools work either way. See{" "}
        <Link href="/help" className="font-semibold text-blue-700 underline dark:text-blue-300">
          privacy details
        </Link>
        .
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            setAdConsent("granted");
            setVisible(false);
          }}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500"
        >
          Allow personalised ads
        </button>
        <button
          type="button"
          onClick={() => {
            setAdConsent("denied");
            setVisible(false);
          }}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          Continue without ads
        </button>
      </div>
    </div>
  );
}
