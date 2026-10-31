"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  Clock,
  FileDown,
  FileSpreadsheet,
  FilePlus2,
  GitCompare,
  Layers,
  PenLine,
  PenTool,
  Puzzle,
  ScanText,
  Search,
  Shield,
  Sparkles,
  Star,
  Upload,
} from "lucide-react";
import { useWorkspace } from "@/lib/store";
import { apiJson, formatBytes, type SessionMeta } from "@/lib/browser";
import { createBlankPdf, createSamplePdf } from "@/lib/pdf/operations";
import { Button, Card, Dropzone, Notice } from "@/components/ui";

type ToolCard = { title: string; text: string; href: string; icon: LucideIcon; tone: string; keywords: string };

const TOOLS: ToolCard[] = [
  { title: "Editor", text: "View, annotate, add and replace text, insert images, reorder pages, redact and export.", href: "/editor", icon: PenTool, tone: "text-red-600 bg-red-50 dark:bg-red-950/40", keywords: "edit annotate text image highlight redact page" },
  { title: "Convert", text: "PDF to Word, Excel, PowerPoint, text, HTML, images, EPUB and more. Office and images to PDF.", href: "/convert", icon: FileDown, tone: "text-blue-600 bg-blue-50 dark:bg-blue-950/40", keywords: "convert word excel powerpoint docx xlsx pptx image png jpg epub odt rtf" },
  { title: "OCR", text: "Recognize text in scanned PDFs and images. Export searchable PDFs, DOCX, TXT and tables.", href: "/ocr", icon: ScanText, tone: "text-violet-600 bg-violet-50 dark:bg-violet-950/40", keywords: "ocr scan searchable text recognize tesseract" },
  { title: "Merge · Split · Compress", text: "Combine PDFs, split by range or per page, rotate, add watermarks and page numbers in bulk.", href: "/tools", icon: Layers, tone: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40", keywords: "merge split compress batch rotate watermark numbers zip" },
  { title: "Sign & Secure", text: "Draw, type or upload a signature. Password-protect PDFs and remove protection you are authorized to remove.", href: "/sign", icon: PenLine, tone: "text-amber-600 bg-amber-50 dark:bg-amber-950/40", keywords: "sign signature password encrypt protect redact security" },
  { title: "Compare", text: "Visual pixel comparison and text differences between two PDFs.", href: "/compare", icon: GitCompare, tone: "text-indigo-600 bg-indigo-50 dark:bg-indigo-950/40", keywords: "compare diff difference visual text" },
  { title: "Recent & jobs", text: "Recently opened files, starred items, recovery copies and a processing log.", href: "/recent", icon: Clock, tone: "text-slate-600 bg-slate-100 dark:bg-slate-800", keywords: "recent history starred recovery log jobs" },
  { title: "Chrome extension", text: "Open PDFs from right-click menus and the toolbar in PDF Pro. Minimal permissions.", href: "/extension", icon: Puzzle, tone: "text-pink-600 bg-pink-50 dark:bg-pink-950/40", keywords: "extension chrome browser install manifest" },
];

type DocMeta = { id: number; name: string; size: number; pages: number; starred: boolean; updatedAt: string };

export default function Dashboard() {
  const router = useRouter();
  const { openBytes, stage, recoverable, restoreSession, discardSession, notify, refreshRecoverable } = useWorkspace();
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiJson<{ documents: DocMeta[] }>("/api/documents")
      .then((r) => setDocs(r.documents))
      .catch(() => setDocs([]));
    void refreshRecoverable();
  }, [refreshRecoverable]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return TOOLS;
    return TOOLS.filter((t) => `${t.title} ${t.text} ${t.keywords}`.toLowerCase().includes(term));
  }, [q]);

  const onFiles = async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    if (/\.pdf$/i.test(f.name) || f.type === "application/pdf") {
      router.push("/editor");
      // Hand the file to the editor through the workspace store.
      stage([f]);
      return;
    }
    stage(files);
    notify("info", "Files are ready in Convert. Choose the output format there.");
    router.push("/convert");
  };

  const sample = async () => {
    setBusy(true);
    try {
      const bytes = await createSamplePdf();
      await openBytes("PDF-Pro-Sample.pdf", bytes.slice().buffer as ArrayBuffer);
      router.push("/editor");
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Could not create the sample.");
    } finally {
      setBusy(false);
    }
  };

  const blank = async () => {
    setBusy(true);
    try {
      const bytes = await createBlankPdf();
      await openBytes("Untitled.pdf", bytes.slice().buffer as ArrayBuffer);
      router.push("/editor");
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Could not create the document.");
    } finally {
      setBusy(false);
    }
  };

  const starred = (docs ?? []).filter((d) => d.starred);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-8 px-4 py-8">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#0c1d33] via-[#12325e] to-blue-700 p-8 text-white shadow-xl md:p-12">
        <p className="text-sm font-semibold tracking-widest text-blue-300">PRIVATE BY DEFAULT · NO ACCOUNT REQUIRED</p>
        <h1 className="mt-3 text-4xl font-black leading-[1.05] md:text-5xl">
          Edit PDFs like a pro.
          <br />
          <span className="text-blue-300">Convert, OCR, sign and secure</span> in one place.
        </h1>
        <p className="mt-4 max-w-2xl text-blue-100">
          Files are processed in your browser. Nothing is uploaded to a server for the tools on this site. Only file names, sizes and page counts are saved in your workspace database, and only if you choose to keep history.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button variant="secondary" size="lg" className="!bg-white !text-[#0c1d33] hover:!bg-blue-50" onClick={() => router.push("/editor")}>
            <Upload size={18} /> Open a PDF
          </Button>
          <Button variant="primary" size="lg" className="!bg-blue-500 hover:!bg-blue-400" onClick={sample} disabled={busy}>
            <Sparkles size={18} /> Try the sample
          </Button>
          <Button variant="primary" size="lg" className="!bg-white/15 hover:!bg-white/25" onClick={blank} disabled={busy}>
            <FilePlus2 size={18} /> Create PDF
          </Button>
        </div>
      </section>

      {recoverable.length > 0 && (
        <Notice tone="warn">
          <div className="space-y-2">
            <p className="font-semibold">Recovered work is available</p>
            {recoverable.slice(0, 3).map((m: SessionMeta) => (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>{m.name} (autosaved {new Date(m.savedAt).toLocaleString()})</span>
                <span className="flex gap-2">
                  <Button size="sm" variant="primary" onClick={() => restoreSession(m).then(() => router.push("/editor")).catch((e: Error) => notify("error", e.message))}>Restore</Button>
                  <Button size="sm" onClick={() => discardSession(m.id)}>Discard</Button>
                </span>
              </div>
            ))}
          </div>
        </Notice>
      )}

      <Dropzone
        multiple
        accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.tif,.tiff,.txt,.md,.html,application/pdf"
        title="Drop PDFs, Word, Excel, PowerPoint or images here"
        hint="PDFs open in the editor. Office files and images go to the Convert center. Maximum size is set in Settings (default 100 MB)."
        onFiles={onFiles}
      />

      <section aria-labelledby="tools-heading">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="tools-heading" className="text-xl font-black text-slate-900 dark:text-slate-100">All tools</h2>
          <label className="flex items-center gap-2 rounded-xl border bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
            <Search size={16} className="text-slate-400" aria-hidden />
            <span className="sr-only">Search tools</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools (e.g. convert, sign)" className="w-56 bg-transparent text-sm outline-none" />
          </label>
        </div>
        {filtered.length === 0 && <p className="text-sm text-slate-500">No tools match “{q}”.</p>}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {filtered.map((t) => (
            <Link key={t.href} href={t.href} className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg dark:border-slate-700 dark:bg-slate-900">
              <span className={`inline-flex rounded-xl p-3 ${t.tone}`}><t.icon size={22} aria-hidden /></span>
              <h3 className="mt-3 font-bold text-slate-900 dark:text-slate-100">{t.title}</h3>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t.text}</p>
            </Link>
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Recent documents" icon={<Clock size={18} aria-hidden />} actions={<Link href="/recent" className="text-sm font-semibold text-blue-600">View all</Link>} className="lg:col-span-2">
          {docs === null && <p className="text-sm text-slate-500">Loading…</p>}
          {docs?.length === 0 && <p className="text-sm text-slate-500">No documents yet. Open a PDF to start — its name and size will appear here.</p>}
          {docs?.slice(0, 6).map((d) => (
            <div key={d.id} className="flex items-center justify-between border-b py-2 text-sm last:border-0 dark:border-slate-700">
              <span className="flex min-w-0 items-center gap-2">
                {d.starred && <Star size={13} className="shrink-0 fill-amber-400 text-amber-400" aria-label="Starred" />}
                <span className="truncate">{d.name}</span>
              </span>
              <span className="shrink-0 text-xs text-slate-400">{d.pages} p · {formatBytes(d.size)}</span>
            </div>
          ))}
        </Card>
        <Card title="Starred" icon={<Star size={18} aria-hidden />}>
          {starred.length === 0 ? (
            <p className="text-sm text-slate-500">Star a recent document on the Recent page to pin it here.</p>
          ) : (
            starred.map((d) => <p key={d.id} className="truncate border-b py-2 text-sm last:border-0">{d.name}</p>)
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Quick batch actions" icon={<Layers size={18} aria-hidden />}>
          <ul className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
            <li>• Merge several PDFs in a chosen order — <Link className="font-semibold text-blue-600" href="/tools">Merge</Link></li>
            <li>• Split a PDF by ranges or into one file per page — <Link className="font-semibold text-blue-600" href="/tools">Split</Link></li>
            <li>• Compress many files at once and download a ZIP — <Link className="font-semibold text-blue-600" href="/tools">Batch</Link></li>
            <li>• OCR several scans, then export text or searchable PDFs — <Link className="font-semibold text-blue-600" href="/ocr">OCR</Link></li>
          </ul>
        </Card>
        <Card title="Privacy at a glance" icon={<Shield size={18} aria-hidden />}>
          <ul className="list-disc space-y-2 pl-5 text-sm text-slate-600 dark:text-slate-300">
            <li>Editing, conversion, OCR and compression run in your browser.</li>
            <li>Unsaved edits are autosaved in this browser’s IndexedDB so they can be recovered.</li>
            <li>Saved signatures are stored only after you click Save, and can be deleted.</li>
            <li>Secure redaction removes covered text from the exported file. A black box alone does not.</li>
          </ul>
          <p className="mt-3 flex items-center gap-2 text-xs text-slate-500"><FileSpreadsheet size={14} aria-hidden /> Excel and Word exports are checked by a parser before download.</p>
        </Card>
      </div>
    </div>
  );
}
