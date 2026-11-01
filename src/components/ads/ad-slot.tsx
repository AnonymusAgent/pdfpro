"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/components/auth/session-provider";

const CONSENT_KEY = "pdfpro-ads-consent";
const CONSENT_EVENT = "pdfpro-ads-consent-change";

type AdsConfig = { enabled: boolean; publisherId: string; slots: Record<string, string>; requireConsent: boolean };

export type AdPlacement = "dashboard" | "cloud" | "tools" | "pricing";

function readConsent(): "granted" | "denied" | "unset" {
  if (typeof window === "undefined") return "unset";
  try {
    const value = window.localStorage.getItem(CONSENT_KEY);
    return value === "granted" || value === "denied" ? value : "unset";
  } catch {
    return "unset";
  }
}

export function setAdConsent(value: "granted" | "denied"): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, value);
    window.dispatchEvent(new Event(CONSENT_EVENT));
  } catch {
    /* storage may be blocked */
  }
}

export function getAdConsent(): "granted" | "denied" | "unset" {
  return readConsent();
}

/**
 * Google AdSense unit for Free accounts only.
 *
 * • Renders nothing unless an administrator has saved a real publisher id and
 *   the ad unit id for this placement (no placeholders, no fake ads).
 * • Never renders for Premium accounts.
 * • Waits for advertising consent when consent is required.
 * • Sits in a clearly labelled container away from tool controls.
 */
export function AdSlot({ placement, className = "" }: { placement: AdPlacement; className?: string }) {
  const { premium } = useSession();
  const [config, setConfig] = useState<AdsConfig | null>(null);
  const [consent, setConsent] = useState<"granted" | "denied" | "unset">("unset");

  useEffect(() => {
    // Consent lives in localStorage, which is only readable in the browser.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConsent(readConsent());
    const update = () => setConsent(readConsent());
    window.addEventListener(CONSENT_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(CONSENT_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/site-config", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { ads?: AdsConfig } | null) => {
        if (active) setConfig(data?.ads ?? null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const slotId = config?.slots?.[placement];
  const eligible = !premium && Boolean(config?.enabled) && Boolean(config?.publisherId) && Boolean(slotId);
  const consentOk = !config?.requireConsent || consent === "granted";

  useEffect(() => {
    if (!eligible || !consentOk || !slotId) return;
    const scriptId = "adsbygoogle-js";
    if (!document.getElementById(scriptId)) {
      const script = document.createElement("script");
      script.id = scriptId;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(config!.publisherId)}`;
      document.head.appendChild(script);
    }
    try {
      const adsbygoogle = ((window as unknown as { adsbygoogle?: unknown[] }).adsbygoogle ??= []);
      adsbygoogle.push({});
    } catch {
      /* AdSense not available (blocked or offline) — the slot stays empty. */
    }
  }, [eligible, consentOk, slotId, config]);

  if (!eligible || !consentOk) return null;

  return (
    <aside className={`w-full ${className}`} aria-label="Advertisement">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">Advertisement</p>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-900">
        <ins
          className="adsbygoogle block"
          style={{ display: "block" }}
          data-ad-client={config!.publisherId}
          data-ad-slot={slotId}
          data-ad-format="auto"
          data-full-width-responsive="true"
        />
      </div>
      <p className="mt-1 text-[10px] text-slate-400">
        Ads keep the Free plan running.{" "}
        <a href="/pricing" className="underline hover:text-slate-600 dark:hover:text-slate-300">
          Go Premium to remove them
        </a>
        .
      </p>
    </aside>
  );
}
