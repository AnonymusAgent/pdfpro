"use client";

/**
 * Cloudflare Turnstile widget (explicit rendering).
 *
 * The script is loaded once per page from `challenges.cloudflare.com` and each
 * form gets its own widget. When the deployment has no site key the component
 * renders nothing at all, so the forms look and behave exactly as before.
 *
 * The token is short-lived (300 s) and single-use; `onToken(null)` is called
 * when it expires or the challenge errors, which disables the submit button
 * until a fresh token arrives.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";

type TurnstileApi = {
  render: (target: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptPromise: Promise<boolean> | null = null;

function loadTurnstile(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.turnstile) return Promise.resolve(true);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<boolean>((resolve) => {
    const selector = "script[data-pdfpro-turnstile]";
    const existing = document.querySelector<HTMLScriptElement>(selector);
    if (existing?.dataset.loaded === "1") {
      resolve(Boolean(window.turnstile));
      return;
    }
    const script = existing ?? document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.dataset.pdfproTurnstile = "1";
    const finish = () => {
      script.dataset.loaded = "1";
      resolve(Boolean(window.turnstile));
    };
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", () => resolve(false), { once: true });
    if (!existing) document.head.appendChild(script);
  });
  return scriptPromise;
}

export function Turnstile({
  siteKey,
  onToken,
  resetKey = 0,
  className,
}: {
  /** Public site key from the server. Empty string disables the widget. */
  siteKey: string;
  /** Called with the token, or `null` when it expires/fails. */
  onToken: (token: string | null) => void;
  /** Increment to force a fresh challenge (e.g. after a rejected token). */
  resetKey?: number;
  className?: string;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;

    void loadTurnstile().then((ready) => {
      if (cancelled) return;
      if (!ready || !holder.current || !window.turnstile) {
        setUnavailable(true);
        return;
      }
      setUnavailable(false);
      widgetId.current = window.turnstile.render(holder.current, {
        sitekey: siteKey,
        theme: "auto",
        callback: (token: string) => onToken(token),
        "expired-callback": () => onToken(null),
        "error-callback": () => onToken(null),
        "timeout-callback": () => onToken(null),
      });
    });

    return () => {
      cancelled = true;
      const api = window.turnstile;
      if (api && widgetId.current) {
        try {
          api.remove(widgetId.current);
        } catch {
          // The widget was already torn down (fast navigation); nothing to do.
        }
      }
      widgetId.current = null;
    };
  }, [siteKey, onToken]);

  const reset = useCallback(() => {
    onToken(null);
    if (window.turnstile && widgetId.current) {
      try {
        window.turnstile.reset(widgetId.current);
      } catch {
        // Ignore: the next render creates a new widget.
      }
    }
  }, [onToken]);

  useEffect(() => {
    if (resetKey > 0) reset();
  }, [resetKey, reset]);

  if (!siteKey) return null;

  return (
    <div className={className}>
      <div ref={holder} data-testid="turnstile-widget" />
      {unavailable ? (
        <p className="mt-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
          The verification widget could not load. Check your connection and reload the page.
        </p>
      ) : (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
          <ShieldCheck size={12} aria-hidden /> Protected by Cloudflare Turnstile
        </p>
      )}
    </div>
  );
}
