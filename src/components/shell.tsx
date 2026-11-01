"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Clock,
  CloudUpload,
  CreditCard,
  Crown,
  FileDown,
  FileText,
  GitCompare,
  HelpCircle,
  Home,
  Layers,
  LayoutDashboard,
  LogOut,
  Moon,
  PenLine,
  Puzzle,
  ScanText,
  Settings,
  Shield,
  Sun,
  UserRound,
} from "lucide-react";
import { WorkspaceProvider, useWorkspace } from "@/lib/store";
import { applyTheme, loadSettings, saveSettings } from "@/lib/browser";
import { useLocal } from "@/lib/use-local";
import { ConfirmDialog, Toaster } from "@/components/ui";
import { SessionProvider, useSession, userInitials } from "@/components/auth/session-provider";
import { ConsentBanner } from "@/components/ads/consent-banner";
import type { SessionPayload } from "@/lib/session-types";

function readTheme(raw: string | null): string | undefined {
  try {
    return raw ? (JSON.parse(raw) as { theme?: string }).theme : undefined;
  } catch {
    return undefined;
  }
}

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Home", icon: Home },
  { href: "/editor", label: "Editor", icon: FileText },
  { href: "/convert", label: "Convert", icon: FileDown },
  { href: "/ocr", label: "OCR", icon: ScanText },
  { href: "/tools", label: "Merge · Split · Compress", icon: Layers },
  { href: "/sign", label: "Sign & Secure", icon: PenLine },
  { href: "/compare", label: "Compare", icon: GitCompare },
  { href: "/recent", label: "Recent", icon: Clock },
  { href: "/cloud", label: "Cloud storage", icon: CloudUpload },
  { href: "/pricing", label: "Pricing", icon: CreditCard },
  { href: "/extension", label: "Extension", icon: Puzzle },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppProviders({ children, session }: { children: ReactNode; session: SessionPayload | null }) {
  return (
    <SessionProvider initial={session}>
      <WorkspaceProvider>
        <AppShell>{children}</AppShell>
      </WorkspaceProvider>
    </SessionProvider>
  );
}

function AccountMenu() {
  const { session, premium, signedIn, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!signedIn) {
    return (
      <div className="flex items-center gap-1.5">
        <Link
          href="/login"
          className="rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-slate-200 hover:bg-white/10 hover:text-white"
        >
          Sign in
        </Link>
        <Link
          href="/register"
          className="rounded-lg bg-blue-600 px-2.5 py-1.5 text-[13px] font-semibold text-white hover:bg-blue-500"
        >
          Create account
        </Link>
      </div>
    );
  }

  const user = session.user!;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-blue-400"
        aria-label="Account menu"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">
          {userInitials(user)}
        </span>
        {premium && (
          <span className="hidden items-center gap-1 rounded-full bg-amber-400/20 px-2 py-0.5 text-[11px] font-bold text-amber-200 sm:flex">
            <Crown size={11} aria-hidden /> Premium
          </span>
        )}
        <span className="hidden max-w-[110px] truncate text-xs text-slate-300 lg:block">{user.displayName ?? user.email}</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-slate-800 shadow-2xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        >
          <div className="border-b border-slate-100 px-3 py-2 dark:border-slate-800">
            <p className="truncate text-sm font-semibold">{user.displayName ?? "Your account"}</p>
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">{user.email}</p>
            <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {premium ? "Premium plan" : "Free plan"}
              {!user.emailVerified && " · email unverified"}
            </p>
          </div>
          <MenuLink href="/dashboard" icon={LayoutDashboard} label="Dashboard" onClick={() => setOpen(false)} />
          <MenuLink href="/cloud" icon={CloudUpload} label="Cloud storage" onClick={() => setOpen(false)} />
          <MenuLink href="/account" icon={UserRound} label="Account settings" onClick={() => setOpen(false)} />
          {!premium && <MenuLink href="/pricing" icon={CreditCard} label="Upgrade to Premium" onClick={() => setOpen(false)} />}
          {user.isAdmin && <MenuLink href="/admin" icon={Shield} label="Admin dashboard" onClick={() => setOpen(false)} />}
          <button
            type="button"
            role="menuitem"
            onClick={() => void signOut()}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <LogOut size={15} aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function MenuLink({
  href,
  icon: Icon,
  label,
  onClick,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      <Icon size={15} aria-hidden /> {label}
    </Link>
  );
}

function VerifyEmailBanner() {
  const { session } = useSession();
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  if (!session.user || session.user.emailVerified) return null;

  const resend = async () => {
    setState("sending");
    try {
      const response = await fetch("/api/auth/resend-verification", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = (await response.json()) as { error?: string; previewUrl?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not send the email.");
      setState("sent");
      setMessage(data.previewUrl ? `Verification link: ${data.previewUrl}` : "Verification email sent. Check your inbox.");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Could not send the email.");
    }
  };

  return (
    <div className="border-b border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold">Verify your email to unlock cloud uploads and checkout.</span>
        <button
          type="button"
          onClick={() => void resend()}
          disabled={state === "sending"}
          className="rounded-md bg-amber-500 px-2 py-1 font-semibold text-white hover:bg-amber-600 disabled:opacity-60"
        >
          {state === "sending" ? "Sending…" : state === "sent" ? "Sent" : "Resend link"}
        </button>
        {message && <span className="break-all text-[11px]">{message}</span>}
      </div>
    </div>
  );
}

function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { active, toasts, dismissToast, confirmOpts, answerConfirm } = useWorkspace();
  const dark = readTheme(useLocal("pdfpro-settings")) === "dark";

  useEffect(() => {
    applyTheme(loadSettings().theme);
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    saveSettings({ ...loadSettings(), theme: next ? "dark" : "light" });
    applyTheme(next ? "dark" : "light");
  };

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[200] focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-slate-900">
        Skip to content
      </a>
      <header className="sticky top-0 z-50 bg-[#0c1d33] text-white shadow-lg">
        <div className="flex h-[58px] items-center gap-3 px-3 md:px-5">
          <Link href="/" className="flex shrink-0 items-center gap-2 rounded focus-visible:outline-2 focus-visible:outline-blue-400" aria-label="PDF Pro home">
            <span className="rounded-md bg-red-600 px-2 py-1 text-sm font-black tracking-tight">PDF</span>
            <span className="text-lg font-bold">Pro</span>
          </Link>
          <nav aria-label="Main" className="ml-2 hidden items-center gap-1 overflow-x-auto md:flex">
            {NAV.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                aria-current={isActive(pathname, href) ? "page" : undefined}
                title={label}
                className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-blue-400 ${
                  isActive(pathname, href) ? "bg-blue-600 text-white" : "text-slate-300 hover:bg-white/10 hover:text-white"
                }`}
              >
                <Icon size={15} aria-hidden />
                <span className="hidden xl:inline">{label}</span>
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            {active && (
              <span className="hidden max-w-[220px] items-center gap-2 truncate text-xs text-slate-300 2xl:flex" title={active.name}>
                <span className="truncate">{active.name}</span>
                <span className={active.dirty ? "text-amber-300" : "text-emerald-300"}>{active.dirty ? "● Unsaved changes" : "● Saved"}</span>
              </span>
            )}
            <AccountMenu />
            <Link href="/settings" aria-label="Settings" title="Settings" className={`rounded p-2 hover:bg-white/10 ${isActive(pathname, "/settings") ? "bg-white/15" : ""}`}>
              <Settings size={17} />
            </Link>
            <Link href="/help" aria-label="Help and shortcuts" title="Help" className={`rounded p-2 hover:bg-white/10 ${isActive(pathname, "/help") ? "bg-white/15" : ""}`}>
              <HelpCircle size={17} />
            </Link>
            <button onClick={toggleTheme} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} className="rounded p-2 hover:bg-white/10">
              {dark ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </div>
        </div>
        <nav aria-label="Main mobile" className="flex gap-1 overflow-x-auto px-3 pb-2 md:hidden">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(pathname, href) ? "page" : undefined}
              className={`flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-xs ${isActive(pathname, href) ? "bg-blue-600" : "bg-white/10"}`}
            >
              <Icon size={13} aria-hidden />
              {label.split(" ·")[0]}
            </Link>
          ))}
        </nav>
      </header>
      <VerifyEmailBanner />
      <main id="main" className="flex min-h-0 flex-1 flex-col">
        {children}
      </main>
      <footer className="mt-auto border-t border-slate-200 bg-white px-4 py-6 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <p>PDF Pro — private-by-default PDF tools. Cloud storage is optional and always private to your account.</p>
          <nav aria-label="Footer" className="flex flex-wrap gap-4">
            <Link href="/pricing" className="hover:text-slate-800 dark:hover:text-slate-200">Pricing</Link>
            <Link href="/cloud" className="hover:text-slate-800 dark:hover:text-slate-200">Cloud storage</Link>
            <Link href="/help" className="hover:text-slate-800 dark:hover:text-slate-200">Help</Link>
            <Link href="/settings" className="hover:text-slate-800 dark:hover:text-slate-200">Privacy &amp; cookies</Link>
          </nav>
        </div>
      </footer>
      <ConsentBanner />
      <Toaster toasts={toasts} onDismiss={dismissToast} />
      <ConfirmDialog opts={confirmOpts} onAnswer={answerConfirm} />
    </div>
  );
}
