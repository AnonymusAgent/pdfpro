import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-24 text-center">
      <p className="text-sm font-bold uppercase tracking-widest text-blue-600">404</p>
      <h1 className="text-3xl font-black text-slate-900 dark:text-slate-100">This page does not exist</h1>
      <p className="text-slate-600 dark:text-slate-400">The link may be outdated, or the page was moved. Your documents were not affected.</p>
      <div className="flex flex-wrap justify-center gap-3">
        <Link href="/" className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-500">
          Go to home
        </Link>
        <Link href="/editor" className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-800 dark:bg-slate-800 dark:text-slate-100">
          Open editor
        </Link>
      </div>
    </div>
  );
}
