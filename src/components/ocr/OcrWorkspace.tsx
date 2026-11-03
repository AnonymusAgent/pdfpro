"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScanText, Upload, Square, FileText, Table2, FileDown, Search, Copy } from "lucide-react";
import { useWorkspace } from "@/lib/store";
import { Button, Card, Dropzone, Notice, PageTitle, ProgressBar, Spinner, cn, inputCls, labelCls } from "@/components/ui";
import { apiJson, baseName, bytesToBase64, downloadBytes } from "@/lib/browser";
import { openPdf, pageSize, rasterize, canvasToBytes, releasePdf } from "@/lib/pdf/pdfjs";
import { readOcrFiles } from "@/lib/pdf/ocr-files";
import { uid } from "@/lib/pdf/types";
import { OCR_LANGUAGES, LOW_CONFIDENCE, buildSearchablePdf, runOcr, type OcrPageInput, type OcrPageResult } from "@/lib/pdf/ocr";
import { layoutPage, type LayoutPage } from "@/lib/pdf/layout";
import * as conv from "@/lib/pdf/convert-out";
import { MIME_TYPES, verifyOutput } from "@/lib/pdf/validate";

const SCALE = 2.5;

type JobState = {
  id: string;
  name: string;
  kind: "pdf" | "image";
  bytes: ArrayBuffer;
  status: "queued" | "running" | "done" | "cancelled" | "error";
  error?: string;
  pages: OcrPageResult[];
  jpegs: Uint8Array[];
};

function layoutFromOcr(pages: OcrPageResult[]): LayoutPage[] {
  return pages.map((p) =>
    layoutPage(p.index, p.widthPt, p.heightPt, p.words.map((w) => ({ str: w.text, x: w.x, y: w.y, w: w.w, h: w.h }))),
  );
}

function paragraphsToLayout(pages: { index: number; text: string; widthPt: number; heightPt: number }[]): LayoutPage[] {
  return pages.map((p) => ({
    index: p.index,
    width: p.widthPt,
    height: p.heightPt,
    lines: [],
    blocks: p.text
      .split(/\n{2,}/)
      .map((t) => t.replace(/\n/g, " ").trim())
      .filter(Boolean)
      .map((t) => ({ type: "paragraph" as const, text: t, top: 0 })),
  }));
}

export default function OcrWorkspace() {
  const { active, notify, takeStaged } = useWorkspace();
  const [jobs, setJobs] = useState<JobState[]>([]);
  const [langs, setLangs] = useState<string[]>(["eng"]);
  const [preprocess, setPreprocess] = useState(true);
  const [rotateAuto, setRotateAuto] = useState(true);
  const [range, setRange] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ pct: 0, status: "" });
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [selectedPage, setSelectedPage] = useState(0);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [find, setFind] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const addFiles = useCallback((files: File[]) => {
    void readOcrFiles(files).then(({ accepted, errors }) => {
      for (const error of errors) notify("error", error);
      const next: JobState[] = accepted.map((file) => ({
        id: uid(), name: file.name, kind: file.kind, bytes: file.bytes,
        status: "queued", pages: [], jpegs: [],
      }));
      if (next.length) {
        setJobs((prev) => [...prev, ...next]);
        setSelectedJob((prev) => prev ?? next[0]!.id);
      }
    }).catch(() => notify("error", "Could not read the selected OCR files. Please try again."));
  }, [notify]);

  useEffect(() => {
    const staged = takeStaged();
    if (staged.length) addFiles(staged);
  }, [addFiles, takeStaged]);

  const job = jobs.find((j) => j.id === selectedJob) ?? jobs[0] ?? null;
  const page = job?.pages[selectedPage] ?? null;
  const previewBytes = job?.jpegs[selectedPage];
  const previewUrl = useMemo(
    () => previewBytes ? `data:image/jpeg;base64,${bytesToBase64(previewBytes)}` : null,
    [previewBytes],
  );

  const addActive = async () => {
    if (!active) return;
    setJobs((prev) => [...prev, { id: `${active.id}-ocr-${Date.now()}`, name: active.name, kind: "pdf", bytes: active.bytes.slice(0), status: "queued", pages: [], jpegs: [] }]);
  };

  const pagesToRun = (count: number): number[] => {
    const spec = range.trim();
    if (!spec) return Array.from({ length: count }, (_, i) => i);
    const out = new Set<number>();
    for (const part of spec.split(",")) {
      const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
      if (!m) throw new Error(`“${part.trim()}” is not a valid page range. Use values like 1-3, 5.`);
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : a;
      for (let i = a; i <= b; i++) if (i >= 1 && i <= count) out.add(i - 1);
    }
    if (!out.size) throw new Error(`The range is outside the document (${count} pages).`);
    return [...out].sort((x, y) => x - y);
  };

  const runAll = async () => {
    if (!langs.length) {
      notify("error", "Select at least one OCR language.");
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    try {
      for (const j of jobs) {
        if (j.status === "done" || ctrl.signal.aborted) continue;
        setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, status: "running", error: undefined } : x)));
        const jpegs: Uint8Array[] = [];
        try {
          let inputs: OcrPageInput[] = [];
          if (j.kind === "pdf") {
            const pdf = await openPdf(j.bytes);
            const picks = pagesToRun(pdf.numPages);
            inputs = await Promise.all(
              picks.map(async (i) => {
                const probe = await pdf.getPage(i + 1);
                const s = pageSize(probe);
                const widthPt = s.rotate % 180 ? s.H : s.W;
                const heightPt = s.rotate % 180 ? s.W : s.H;
                return {
                  index: i,
                  widthPt,
                  heightPt,
                  render: async () => {
                    const page = await pdf.getPage(i + 1);
                    const canvas = await rasterize(page, { scale: SCALE, rotation: page.rotate });
                    jpegs.push(await canvasToBytes(canvas, "image/jpeg", 0.82));
                    return canvas;
                  },
                };
              }),
            );
            const res = await runOcr({
              pages: inputs,
              langs,
              preprocess,
              rotateAuto,
              signal: ctrl.signal,
              onProgress: (p) => setProgress({ pct: p.pct, status: `${j.name}: ${p.status} (page ${p.page} of ${p.pages})` }),
            });
            releasePdf(pdf);
            setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, status: res.cancelled ? "cancelled" : "done", pages: res.results, jpegs } : x)));
          } else {
            const blob = new Blob([j.bytes], { type: /png/i.test(j.name) ? "image/png" : "image/jpeg" });
            const bitmap = await createImageBitmap(blob);
            const input: OcrPageInput = {
              index: 0,
              widthPt: bitmap.width / SCALE,
              heightPt: bitmap.height / SCALE,
              render: async () => {
                const c = document.createElement("canvas");
                c.width = bitmap.width;
                c.height = bitmap.height;
                c.getContext("2d")?.drawImage(bitmap, 0, 0);
                jpegs.push(await canvasToBytes(c, "image/jpeg", 0.85));
                return c;
              },
            };
            const res = await runOcr({ pages: [input], langs, preprocess, rotateAuto, signal: ctrl.signal, onProgress: (p) => setProgress({ pct: p.pct, status: `${j.name}: ${p.status}` }) });
            bitmap.close();
            setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, status: res.cancelled ? "cancelled" : "done", pages: res.results, jpegs } : x)));
          }
          if (ctrl.signal.aborted) break;
        } catch (e) {
          const reason = e instanceof Error ? e.message : String((e as { message?: unknown } | null)?.message ?? "");
          const detail = reason || "the browser OCR engine could not start (check that the Tesseract files in /vendor/tesseract are available)";
          setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, status: "error", error: `OCR failed: ${detail}.` } : x)));
        }
      }
      setSelectedJob((cur) => cur ?? jobs[0]?.id ?? null);
      apiJson("/api/jobs", { method: "POST", body: JSON.stringify({ kind: "ocr", fileName: jobs[0]?.name ?? "scan", inputSize: jobs.reduce((a, j) => a + j.bytes.byteLength, 0), outputSize: 0, message: ctrl.signal.aborted ? "cancelled" : "OCR run" }) }).catch(() => undefined);
    } finally {
      setRunning(false);
      abortRef.current = null;
      setProgress({ pct: 100, status: "Finished" });
    }
  };

  const textOf = (j: JobState, p: OcrPageResult) => edits[`${j.id}:${p.index}`] ?? p.text;

  const exportAs = async (kind: "txt" | "md" | "docx" | "xlsx" | "csv" | "searchable") => {
    if (!job || !job.pages.length) return;
    try {
      const base = baseName(job.name);
      if (kind === "txt" || kind === "md") {
        const body = job.pages
          .map((p) => (kind === "md" ? `## Page ${p.index + 1}\n\n${textOf(job, p)}` : `--- Page ${p.index + 1} ---\n${textOf(job, p)}`))
          .join("\n\n");
        const bytes = new TextEncoder().encode(body + "\n");
        downloadBytes(bytes, `${base}-ocr.${kind}`, kind === "md" ? "text/markdown" : "text/plain");
        return;
      }
      if (kind === "docx") {
        const out = await conv.toDocx(paragraphsToLayout(job.pages.map((p) => ({ index: p.index, text: textOf(job, p), widthPt: p.widthPt, heightPt: p.heightPt }))), "editable");
        const check = await verifyOutput("docx", out);
        if (!check.ok) throw new Error(check.error);
        downloadBytes(out, `${base}-ocr.docx`, MIME_TYPES.docx);
        return;
      }
      if (kind === "xlsx" || kind === "csv") {
        const layout = layoutFromOcr(job.pages);
        const bytes = kind === "xlsx" ? await conv.toXlsx(layout, "perTable") : new TextEncoder().encode(conv.toCsv(layout));
        const check = await verifyOutput(kind, bytes);
        if (!check.ok) throw new Error(check.error);
        downloadBytes(bytes, `${base}-ocr-tables.${kind}`, MIME_TYPES[kind]);
        return;
      }
      if (kind === "searchable") {
        const pages = job.pages.map((p, k) => ({ jpeg: job.jpegs[k] ?? new Uint8Array(), widthPt: p.widthPt, heightPt: p.heightPt, words: p.words }));
        const { bytes, warnings } = await buildSearchablePdf(pages);
        const check = await verifyOutput("pdf", bytes);
        if (!check.ok) throw new Error(check.error);
        downloadBytes(bytes, `${base}-searchable.pdf`, MIME_TYPES.pdf);
        warnings.forEach((w) => notify("info", w));
        notify("success", "Searchable PDF created and verified. Search for words in any PDF reader.");
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      notify("error", e instanceof Error ? e.message : "Export failed.");
    }
  };

  const findHits = useMemo(() => {
    if (!find.trim() || !page) return 0;
    const text = textOf(job!, page).toLowerCase();
    return text.split(find.trim().toLowerCase()).length - 1;
  }, [find, page, job, edits]); // eslint-disable-line react-hooks/exhaustive-deps

  const lowWords = page ? page.words.filter((w) => w.conf < LOW_CONFIDENCE) : [];

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8">
      <PageTitle
        title="OCR workspace"
        description="Recognize text in scanned PDFs and images, entirely in your browser. Review and correct the text, then export. Low-confidence words are flagged rather than silently accepted."
      />
      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        <div className="space-y-5">
          <Card title="Input" icon={<ScanText size={18} aria-hidden />}>
            <Dropzone multiple accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" title="Drop scans or images" hint="PDF, PNG or JPEG. Several files run as a batch." onFiles={addFiles} compact />
            {active && <Button size="sm" variant="secondary" className="mt-3 w-full" onClick={addActive}><Upload size={14} /> Add the open document</Button>}
            {jobs.length > 0 && (
              <ul className="mt-3 space-y-1.5 text-sm" aria-label="OCR queue">
                {jobs.map((j) => (
                  <li key={j.id}>
                    <button type="button" onClick={() => { setSelectedJob(j.id); setSelectedPage(0); }} className={cn("flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left", selectedJob === j.id || (!selectedJob && jobs[0]?.id === j.id) ? "bg-blue-50 dark:bg-blue-950/40" : "bg-slate-50 dark:bg-slate-800")}>
                      <span className="truncate">{j.name}</span>
                      <span className={cn("shrink-0 text-xs font-semibold", j.status === "done" ? "text-emerald-600" : j.status === "error" ? "text-red-600" : j.status === "cancelled" ? "text-amber-600" : "text-slate-500")}>
                        {j.status === "queued" ? "Queued" : j.status === "running" ? "Running" : j.status === "done" ? `Done · ${j.pages.length} p` : j.status === "cancelled" ? "Cancelled" : "Error"}
                      </span>
                    </button>
                    {j.error && <p className="px-2 text-xs text-red-600">{j.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Settings" icon={<Square size={18} aria-hidden />}>
            <fieldset className="space-y-2 text-sm">
              <legend className={labelCls}>Languages (downloaded on first use if not English)</legend>
              {OCR_LANGUAGES.map((l) => (
                <label key={l.code} className="flex items-center gap-2">
                  <input type="checkbox" checked={langs.includes(l.code)} onChange={(e) => setLangs(e.target.checked ? [...langs, l.code] : langs.filter((x) => x !== l.code))} />
                  {l.label} <span className="text-xs text-slate-400">({l.code})</span>
                </label>
              ))}
            </fieldset>
            <label className="mt-3 block"><span className={labelCls}>Pages (blank = all; e.g. 1-3, 7)</span>
              <input value={range} onChange={(e) => setRange(e.target.value)} className={inputCls} placeholder="All pages" />
            </label>
            <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={preprocess} onChange={(e) => setPreprocess(e.target.checked)} /> Preprocess: contrast, binarize, despeckle, deskew</label>
            <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={rotateAuto} onChange={(e) => setRotateAuto(e.target.checked)} /> Detect rotated pages (90°/180°/270°)</label>
            <div className="mt-4 flex gap-2">
              <Button variant="primary" onClick={runAll} disabled={running || !jobs.length}>{running ? <Spinner label="Recognizing…" /> : "Run OCR"}</Button>
              {running && <Button variant="danger" onClick={() => abortRef.current?.abort()}>Cancel</Button>}
            </div>
            {(running || progress.pct > 0) && <div className="mt-3"><ProgressBar value={progress.pct} label={progress.status} /></div>}
          </Card>
        </div>

        <div className="space-y-5">
          {!job && <Notice>Add a scan or image, then run OCR. Results appear here with the page image beside the text.</Notice>}
          {job && job.status === "error" && <Notice tone="error">{job.error}</Notice>}
          {job && job.pages.length > 0 && (
            <>
              <div className="grid gap-5 xl:grid-cols-2">
                <Card title={`Page image · ${selectedPage + 1}/${job.pages.length}`} actions={
                  <div className="flex gap-1">
                    <Button size="sm" disabled={selectedPage === 0} onClick={() => setSelectedPage((p) => Math.max(0, p - 1))}>Prev</Button>
                    <Button size="sm" disabled={selectedPage >= job.pages.length - 1} onClick={() => setSelectedPage((p) => Math.min(job.pages.length - 1, p + 1))}>Next</Button>
                  </div>
                }>
                  {previewUrl ? <img src={previewUrl} alt={`Scanned page ${selectedPage + 1}`} className="max-h-[70vh] w-full rounded-lg object-contain ring-1 ring-slate-200" /> : <p className="text-sm text-slate-500">No preview.</p>}
                </Card>
                <Card title="Recognized text" icon={<FileText size={18} aria-hidden />} actions={
                  <span className="text-xs text-slate-500">
                    Confidence <b className={cn(page && page.confidence >= 80 ? "text-emerald-600" : page && page.confidence >= 60 ? "text-amber-600" : "text-red-600")}>{page?.confidence ?? 0}%</b>
                    {page && page.skewDeg ? ` · deskewed ${page.skewDeg}°` : ""}
                  </span>
                }>
                  <div className="mb-2 flex items-center gap-2">
                    <Search size={14} className="text-slate-400" aria-hidden />
                    <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search recognized text" aria-label="Search recognized text" className={cn(inputCls, "py-1.5")} />
                    {find && <span className="whitespace-nowrap text-xs text-slate-500">{findHits} match(es)</span>}
                  </div>
                  <textarea
                    aria-label="Recognized text (editable)"
                    value={page ? textOf(job, page) : ""}
                    onChange={(e) => page && setEdits({ ...edits, [`${job.id}:${page.index}`]: e.target.value })}
                    rows={18}
                    className={cn(inputCls, "font-mono text-[13px] leading-relaxed")}
                  />
                  {lowWords.length > 0 && (
                    <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                      <b>{lowWords.length} low-confidence word(s) to review (&lt;{LOW_CONFIDENCE}%):</b>{" "}
                      {lowWords.slice(0, 40).map((w, i) => <span key={i} className="mr-1.5 inline-block rounded bg-amber-200/70 px-1 dark:bg-amber-800/60">{w.text}</span>)}
                    </div>
                  )}
                </Card>
              </div>
              <Card title="Export" icon={<FileDown size={18} aria-hidden />}>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => exportAs("txt")}><FileText size={14} /> Text (TXT)</Button>
                  <Button size="sm" onClick={() => exportAs("md")}>Markdown</Button>
                  <Button size="sm" onClick={() => exportAs("docx")}><FileDown size={14} /> Word (DOCX)</Button>
                  <Button size="sm" onClick={() => exportAs("xlsx")}><Table2 size={14} /> Tables (XLSX)</Button>
                  <Button size="sm" onClick={() => exportAs("csv")}>Tables (CSV)</Button>
                  <Button size="sm" variant="success" onClick={() => exportAs("searchable")}>Searchable PDF</Button>
                  <Button size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(textOf(job, page!)).then(() => notify("success", "Page text copied."))}><Copy size={14} /> Copy page</Button>
                </div>
                <p className="mt-3 text-xs text-slate-500">Searchable PDF keeps each scanned page image and adds the recognized words as invisible text at their measured positions. Accuracy depends on the scan; always proofread before relying on it.</p>
              </Card>
            </>
          )}
          {job && job.status === "running" && <Card><Spinner label="Recognizing text…" /></Card>}
          <Notice>
            OCR runs locally. English language data is bundled; other languages are fetched once from the jsDelivr CDN as Tesseract language packs (no document content is sent).
          </Notice>
        </div>
      </div>
    </div>
  );
}

