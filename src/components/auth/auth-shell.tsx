"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:py-16">
      <section className="order-2 lg:order-1">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700 dark:text-blue-300">PDF Pro accounts</p>
        <h1 className="mt-3 text-3xl font-black leading-tight text-slate-900 md:text-4xl dark:text-slate-50">
          Private cloud storage for the PDFs you keep coming back to.
        </h1>
        <p className="mt-4 max-w-xl text-sm text-slate-600 dark:text-slate-300">
          Your tools stay free and browser-based. An account adds 2 GB of private cloud storage, file previews on any
          device and optional Premium with 10 GB and no advertising.
        </p>
        <ul className="mt-6 space-y-2 text-sm text-slate-700 dark:text-slate-300">
          {[
            "PDFs are stored in a private bucket — only your account can list or download them.",
            "Downloads use short-lived signed links, never public URLs.",
            "Upgrade or cancel any time; files are never deleted when a plan ends.",
          ].map((item) => (
            <li key={item} className="flex gap-2">
              <ShieldCheck size={16} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden />
              <span>{item}</span>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex flex-wrap gap-3 text-sm">
          <Link href="/pricing" className="rounded-lg border border-slate-300 bg-white px-3 py-2 font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
            Compare Free &amp; Premium
          </Link>
          <Link href="/" className="rounded-lg px-3 py-2 font-semibold text-blue-700 hover:underline dark:text-blue-300">
            Continue without an account
          </Link>
        </div>
      </section>

      <section className="order-1 w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-xl lg:order-2 dark:border-slate-700 dark:bg-slate-900">
        <h2 className="text-xl font-bold text-slate-900 dark:text-slate-50">{title}</h2>
        {subtitle && <div className="mt-1 text-sm text-slate-600 dark:text-slate-400">{subtitle}</div>}
        <div className="mt-5">{children}</div>
        {footer && <div className="mt-5 border-t border-slate-100 pt-4 text-sm dark:border-slate-800">{footer}</div>}
      </section>
    </div>
  );
}

export function GoogleButton({ enabled, next }: { enabled: boolean; next?: string }) {
  if (!enabled) {
    return (
      <div className="space-y-1">
        <button
          type="button"
          disabled
          title="Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable Google sign-in"
          className="flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-400 dark:border-slate-700 dark:bg-slate-800/60"
        >
          <GoogleMark muted /> Continue with Google
        </button>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          Google sign-in is not configured on this deployment yet. Email and password works now.
        </p>
      </div>
    );
  }
  const href = `/api/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ""}`;
  return (
    <a
      href={href}
      className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
    >
      <GoogleMark /> Continue with Google
    </a>
  );
}

function GoogleMark({ muted }: { muted?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden style={{ opacity: muted ? 0.4 : 1 }}>
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.6 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-2.8-.4-4.1H24v8.4h12.5c-.3 2.1-1.6 5.2-4.7 7.3l7.6 5.9c4.5-4.1 6.7-10.2 6.7-17.5z" />
      <path fill="#FBBC05" d="M10.4 28.7A14.6 14.6 0 0 1 9.6 24c0-1.6.3-3.2.8-4.7l-7.8-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.8-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.8 2.4-8.3 2.4-6.4 0-11.7-3.7-13.6-9.8l-7.8 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
      {message}
    </p>
  );
}

export function FormNotice({ tone = "info", children }: { tone?: "info" | "success" | "warn"; children: ReactNode }) {
  const classes =
    tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100"
      : tone === "warn"
        ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
        : "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100";
  return <div className={`rounded-lg border px-3 py-2 text-sm ${classes}`}>{children}</div>;
}
