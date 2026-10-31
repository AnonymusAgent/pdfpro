"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Log only the error class and digest; never document content.
    console.error("PDF Pro route error:", error.name, error.digest ?? "");
  }, [error]);
  return (
    <div role="alert" className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-24 text-center">
      <h1 className="text-2xl font-black text-slate-900 dark:text-slate-100">Something went wrong on this page</h1>
      <p className="text-slate-600 dark:text-slate-400">
        Unsaved edits in open documents are kept in this browser&apos;s recovery storage. Try again, or go back to the home page.
      </p>
      <div className="flex gap-3">
        <button onClick={reset} className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-500">
          Try again
        </button>
        <Link href="/" className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-800 dark:bg-slate-800 dark:text-slate-100">
          Home
        </Link>
      </div>
    </div>
  );
}
