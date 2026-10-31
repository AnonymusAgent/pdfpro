"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Clock, FileDown, FileText, GitCompare, HelpCircle, Home, Layers, Moon, PenLine, Puzzle, ScanText, Settings, Sun } from "lucide-react";
import { WorkspaceProvider, useWorkspace } from "@/lib/store";
import { applyTheme, loadSettings, saveSettings } from "@/lib/browser";
import { useLocal } from "@/lib/use-local";

function readTheme(raw: string | null): string | undefined {
  try {
    return raw ? (JSON.parse(raw) as { theme?: string }).theme : undefined;
  } catch {
    return undefined;
  }
}
import { ConfirmDialog, Toaster } from "@/components/ui";

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Home", icon: Home },
  { href: "/editor", label: "Editor", icon: FileText },
  { href: "/convert", label: "Convert", icon: FileDown },
  { href: "/ocr", label: "OCR", icon: ScanText },
  { href: "/tools", label: "Merge · Split · Compress", icon: Layers },
  { href: "/sign", label: "Sign & Secure", icon: PenLine },
  { href: "/compare", label: "Compare", icon: GitCompare },
  { href: "/recent", label: "Recent", icon: Clock },
  { href: "/extension", label: "Extension", icon: Puzzle },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <AppShell>{children}</AppShell>
    </WorkspaceProvider>
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
              <span className="hidden max-w-[260px] items-center gap-2 truncate text-xs text-slate-300 lg:flex" title={active.name}>
                <span className="truncate">{active.name}</span>
                <span className={active.dirty ? "text-amber-300" : "text-emerald-300"}>{active.dirty ? "● Unsaved changes" : "● Saved"}</span>
              </span>
            )}
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
      <main id="main" className="flex min-h-0 flex-1 flex-col">
        {children}
      </main>
      <Toaster toasts={toasts} onDismiss={dismissToast} />
      <ConfirmDialog opts={confirmOpts} onAnswer={answerConfirm} />
    </div>
  );
}
