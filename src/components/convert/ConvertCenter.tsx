"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { FileDown, FileText, FileSpreadsheet, Image as ImageIcon, Presentation, Globe, BookOpen, Search, Lock, X } from "lucide-react";
import { useWorkspace } from "@/lib/store";
import { Button, Card, Dropzone, Notice, PageTitle, ProgressBar, Spinner, cn, inputCls, labelCls } from "@/components/ui";
import { apiJson, baseName, downloadBytes, formatBytes } from "@/lib/browser";
import { openPdf, rasterize, canvasToBytes, releasePdf } from "@/lib/pdf/pdfjs";
import { extractLayout, renderPagePng, abortError } from "@/lib/pdf/extract";
import * as conv from "@/lib/pdf/convert-out";
import { fileToPdf, UnsupportedFormatError } from "@/lib/pdf/convert-in";
import { mergeDocuments } from "@/lib/pdf/operations";
import { EXTENSIONS, MIME_TYPES, verifyOutput, type OutputKind } from "@/lib/pdf/validate";
import type { LayoutPage } from "@/lib/pdf/layout";

type Group = "pdf-to" | "to-pdf";

type Op = {
  id: string;
  group: Group;
  label: string;
  desc: string;
  icon: typeof FileText;
  kind: OutputKind;
  options?: "docx" | "xlsx" | "pptx" | "raster" | "tiff";
  status?: "ready" | "needs-ocr" | "unsupported";
  note?: string;
};

const OPS: Op[] = [
  { id: "docx", group: "pdf-to", label: "PDF → Word (DOCX)", desc: "Editable paragraphs, headings, lists and tables; or a layout-preserving mode with page images.", icon: FileText, kind: "docx", options: "docx" },
  { id: "xlsx", group: "pdf-to", label: "PDF → Excel (XLSX)", desc: "Detects tables and writes numeric values as numbers. One sheet per table, or one combined sheet.", icon: FileSpreadsheet, kind: "xlsx", options: "xlsx" },
  { id: "csv", group: "pdf-to", label: "PDF → CSV", desc: "Exports detected tables as comma-separated values. Fails with a clear message when no table is found.", icon: FileSpreadsheet, kind: "csv" },
  { id: "pptx", group: "pdf-to", label: "PDF → PowerPoint (PPTX)", desc: "One slide per page at the same page size. Editable text/tables, or full-slide page images.", icon: Presentation, kind: "pptx", options: "pptx" },
  { id: "txt", group: "pdf-to", label: "PDF → Text (TXT)", desc: "Plain text in reading order with page markers.", icon: FileText, kind: "txt" },
  { id: "md", group: "pdf-to", label: "PDF → Markdown", desc: "Headings, lists and tables as Markdown.", icon: FileText, kind: "md" },
  { id: "html", group: "pdf-to", label: "PDF → HTML", desc: "Semantic HTML with one section per page.", icon: Globe, kind: "html" },
  { id: "rtf", group: "pdf-to", label: "PDF → RTF", desc: "Rich Text Format with Unicode escapes.", icon: FileText, kind: "rtf" },
  { id: "odt", group: "pdf-to", label: "PDF → OpenDocument (ODT)", desc: "OpenDocument Text 1.2 for LibreOffice and other suites.", icon: FileText, kind: "odt" },
  { id: "epub", group: "pdf-to", label: "PDF → EPUB", desc: "Reflowable EPUB 3 (text pages). Complex layouts are simplified.", icon: BookOpen, kind: "epub" },
  { id: "png", group: "pdf-to", label: "PDF → PNG", desc: "One PNG per page (ZIP when multiple pages).", icon: ImageIcon, kind: "png", options: "raster" },
  { id: "jpeg", group: "pdf-to", label: "PDF → JPEG", desc: "One JPEG per page (ZIP when multiple pages).", icon: ImageIcon, kind: "jpeg", options: "raster" },
  { id: "tiff", group: "pdf-to", label: "PDF → TIFF", desc: "Uncompressed TIFF per page (ZIP when multiple pages).", icon: ImageIcon, kind: "tiff", options: "tiff" },
  { id: "svg", group: "pdf-to", label: "PDF → SVG", desc: "Per page: the page image with selectable text layered on top.", icon: ImageIcon, kind: "svg" },
  { id: "searchable", group: "pdf-to", label: "PDF → Searchable PDF", desc: "Adds an invisible text layer to scanned pages.", icon: Search, kind: "pdf", status: "needs-ocr", note: "Run OCR first. The OCR workspace creates searchable PDFs from recognized text." },
  { id: "pdfa", group: "pdf-to", label: "PDF → PDF/A", desc: "Archival PDF/A conformance.", icon: Lock, kind: "pdf", status: "unsupported", note: "PDF/A needs a validated conversion engine (for example Ghostscript or veraPDF) that is not available in this build. No file is produced." },
  { id: "word-pdf", group: "to-pdf", label: "Word (DOCX) → PDF", desc: "Headings, paragraphs, tables and images. Complex page layout, headers and fonts are simplified.", icon: FileText, kind: "pdf" },
  { id: "excel-pdf", group: "to-pdf", label: "Excel (XLSX) → PDF", desc: "Each sheet as bordered tables across landscape pages.", icon: FileSpreadsheet, kind: "pdf" },
  { id: "ppt-pdf", group: "to-pdf", label: "PowerPoint (PPTX) → PDF", desc: "One page per slide with text boxes, pictures and tables placed by position.", icon: Presentation, kind: "pdf" },
  { id: "text-pdf", group: "to-pdf", label: "Text, Markdown, HTML → PDF", desc: "Wrapped text with headings, lists and tables.", icon: FileText, kind: "pdf" },
  { id: "images-pdf", group: "to-pdf", label: "Images (PNG, JPEG, TIFF) → PDF", desc: "Each image on an A4 page, or several images combined into one PDF.", icon: ImageIcon, kind: "pdf" },
  { id: "legacy", group: "to-pdf", label: "Legacy .doc / .xls / .ppt → PDF", desc: "Binary Office formats need LibreOffice.", icon: X, kind: "pdf", status: "unsupported", note: "Save the file as .docx, .xlsx or .pptx first. The LibreOffice service is not configured in this build." },
];

type Result = { id: string; name: string; kind: OutputKind; bytes: Uint8Array; detail: string; warnings: string[] };

const ACCEPT = ".pdf,.docx,.xlsx,.pptx,.txt,.md,.html,.htm,.png,.jpg,.jpeg,.tif,.tiff,.doc,.xls,.ppt";
const IN_FILTER: Record<string, RegExp> = {
  "word-pdf": /\.docx$/i,
  "excel-pdf": /\.xlsx$/i,
  "ppt-pdf": /\.pptx$/i,
  "text-pdf": /\.(txt|md|markdown|html?|csv)$/i,
  "images-pdf": /\.(png|jpe?g|tiff?)$/i,
  legacy: /\.(doc|xls|ppt)$/i,
};

async function pdfToOutputs(
  op: Op,
  bytes: ArrayBuffer,
  baseNameStr: string,
  mode: string,
  signal: AbortSignal,
  progress: (f: number, s: string) => void,
): Promise<Result[]> {
  const pdf = await openPdf(bytes);
  try {
    const result = (name: string, kind: OutputKind, data: Uint8Array, detail: string, warnings: string[] = []): Result => ({
      id: `${name}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      kind,
      bytes: data,
      detail,
      warnings,
    });
    if (op.options === "raster" || op.options === "tiff") {
      const outs: Result[] = [];
      const scale = mode === "high" ? 3 : mode === "low" ? 1 : 2;
      for (let i = 0; i < pdf.numPages; i++) {
        if (signal.aborted) throw abortError();
        progress(i / pdf.numPages, `Rendering page ${i + 1} of ${pdf.numPages}`);
        const page = await pdf.getPage(i + 1);
        const canvas = await rasterize(page, { scale, rotation: page.rotate });
        const name = `${baseNameStr}-page-${String(i + 1).padStart(3, "0")}.${op.id === "tiff" ? "tif" : op.id === "jpeg" ? "jpg" : op.id}`;
        if (op.id === "tiff") {
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Canvas unavailable");
          const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          outs.push(result(name, "tiff", conv.toTiff(new Uint8Array(rgba.buffer.slice(0)), canvas.width, canvas.height), `${canvas.width}×${canvas.height} px`));
        } else {
          const bytesOut = await canvasToBytes(canvas, op.id === "png" ? "image/png" : "image/jpeg", 0.92);
          outs.push(result(name, op.kind, bytesOut, `${canvas.width}×${canvas.height} px`));
        }
        canvas.width = 0;
        canvas.height = 0;
      }
      if (outs.length === 1) return outs;
      const zip = new JSZip();
      for (const o of outs) zip.file(o.name, o.bytes);
      return [result(`${baseNameStr}-${op.id}.zip`, "zip", await zip.generateAsync({ type: "uint8array" }), `${outs.length} files in a ZIP`)];
    }
    if (op.id === "svg") {
      const outs: Result[] = [];
      const pages: LayoutPage[] = await extractLayout(pdf, { signal, onProgress: (f) => progress(f * 0.5, "Reading text") });
      for (let i = 0; i < pages.length; i++) {
        if (signal.aborted) throw abortError();
        const png = await renderPagePng(pdf, i, 2);
        outs.push(result(`${baseNameStr}-page-${i + 1}.svg`, "svg", new TextEncoder().encode(conv.toSvg(pages[i], png, `${baseNameStr} page ${i + 1}`)), `${Math.round(pages[i].width)}×${Math.round(pages[i].height)} pt`));
        progress(0.5 + (0.5 * (i + 1)) / pages.length, "Rendering pages");
      }
      if (outs.length === 1) return outs;
      const zip = new JSZip();
      for (const o of outs) zip.file(o.name, o.bytes);
      return [result(`${baseNameStr}-svg.zip`, "zip", await zip.generateAsync({ type: "uint8array" }), `${outs.length} SVG files in a ZIP`)];
    }
    const pages = await extractLayout(pdf, { signal, onProgress: (f) => progress(f * 0.7, "Analyzing layout") });
    progress(0.75, "Building document");
    const warnings: string[] = [];
    const renderPng = (i: number) => renderPagePng(pdf, i, 1.5);
    const enc = new TextEncoder();
    switch (op.id) {
      case "docx": {
        const out = await conv.toDocx(pages, mode === "layout" ? "layout" : "editable", renderPng);
        return [result(`${baseNameStr}.docx`, "docx", out, mode === "layout" ? "Page images (not editable text)" : `${conv.tableCount(pages)} table(s), editable text`, warnings)];
      }
      case "xlsx": {
        const out = await conv.toXlsx(pages, mode === "single" ? "single" : "perTable");
        return [result(`${baseNameStr}.xlsx`, "xlsx", out, `${conv.tableCount(pages)} table(s)`, warnings)];
      }
      case "csv":
        return [result(`${baseNameStr}.csv`, "csv", enc.encode(conv.toCsv(pages)), `${conv.tableCount(pages)} table(s)`, warnings)];
      case "pptx": {
        const out = await conv.toPptx(pages, mode === "image" ? "image" : "editable", renderPng);
        return [result(`${baseNameStr}.pptx`, "pptx", out, `${pages.length} slide(s)`, [...warnings, ...(mode === "image" ? [] : ["Complex layouts may need manual adjustment in PowerPoint."])])];
      }
      case "txt":
        return [result(`${baseNameStr}.txt`, "txt", enc.encode(conv.toText(pages)), `${pages.length} page(s)`)];
      case "md":
        return [result(`${baseNameStr}.md`, "md", enc.encode(conv.toMarkdown(pages)), `${pages.length} page(s)`)];
      case "html":
        return [result(`${baseNameStr}.html`, "html", enc.encode(conv.toHtml(pages, baseNameStr)), `${pages.length} page(s)`)];
      case "rtf":
        return [result(`${baseNameStr}.rtf`, "rtf", enc.encode(conv.toRtf(pages)), `${pages.length} page(s)`)];
      case "odt":
        return [result(`${baseNameStr}.odt`, "odt", await conv.toOdt(pages, baseNameStr), `${pages.length} page(s)`)];
      case "epub":
        return [result(`${baseNameStr}.epub`, "epub", await conv.toEpub(pages, baseNameStr), `${pages.length} page(s)`, ["EPUB is reflowable; page geometry is not preserved."])];
      default:
        throw new UnsupportedFormatError("This conversion is not available.");
    }
  } finally {
    releasePdf(pdf);
  }
}

export default function ConvertCenter() {
  const { active, notify, takeStaged, stage } = useWorkspace();
  const [files, setFiles] = useState<File[]>([]);
  const [useDoc, setUseDoc] = useState(false);
  const [selected, setSelected] = useState<Op | null>(null);
  const [mode, setMode] = useState<string>("editable");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ f: 0, s: "" });
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    Promise.resolve(takeStaged()).then((staged) => {
      if (staged.length) setFiles(staged);
    });
  }, [takeStaged]);

  const filteredOps = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? OPS.filter((o) => o.label.toLowerCase().includes(q) || o.desc.toLowerCase().includes(q)) : OPS;
  }, [query]);

  const pdfInputs = files.filter((f) => /\.pdf$/i.test(f.name));
  const hasSource = files.length > 0 || (useDoc && !!active);

  const acceptsFile = (op: Op, f: File) => {
    if (op.group === "pdf-to") return /\.pdf$/i.test(f.name);
    const re = IN_FILTER[op.id];
    return re ? re.test(f.name) : false;
  };

  const run = async () => {
    if (!selected) return;
    setError(null);
    setResults([]);
    if (selected.status === "unsupported") {
      setError(selected.note ?? "This conversion is not available.");
      return;
    }
    if (selected.status === "needs-ocr") {
      setError(selected.note ?? "Run OCR first.");
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setProgress({ f: 0, s: "Starting" });
    try {
      const out: Result[] = [];
      if (selected.group === "pdf-to") {
        const sources: { name: string; bytes: ArrayBuffer }[] = [];
        for (const f of pdfInputs) sources.push({ name: f.name, bytes: await f.arrayBuffer() });
        if (!sources.length && useDoc && active) sources.push({ name: active.name, bytes: active.bytes.slice(0) });
        if (!sources.length) throw new Error("Choose a PDF to convert, or open one in the editor and select “Use the open document”.");
        for (let k = 0; k < sources.length; k++) {
          if (ctrl.signal.aborted) throw abortError();
          const s = sources[k];
          const part = await pdfToOutputs(selected, s.bytes, baseName(s.name), mode, ctrl.signal, (f, text) =>
            setProgress({ f: ((k + f) / sources.length) * 100, s: `${s.name}: ${text}` }),
          );
          out.push(...part);
        }
      } else {
        const inputs = files.filter((f) => acceptsFile(selected, f));
        if (!inputs.length) throw new Error(`Add ${selected.label.replace(/^.*\s→\s/, "").replace(/\s*\(.*\)$/, "")} files for this conversion.`);
        if (selected.id === "images-pdf" && mode === "combined") {
          const { imagesToPdf } = await import("@/lib/pdf/convert-in");
          const warnings = new Set<string>();
          const bytes = await imagesToPdf(await Promise.all(inputs.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))), true, warnings);
          out.push({ id: "combined", name: "images-combined.pdf", kind: "pdf", bytes, detail: `${inputs.length} image(s) on A4 pages`, warnings: [...warnings] });
        } else {
          const converted: { name: string; bytes: Uint8Array; warnings: string[] }[] = [];
          for (let k = 0; k < inputs.length; k++) {
            if (ctrl.signal.aborted) throw abortError();
            const f = inputs[k];
            setProgress({ f: (k / inputs.length) * 100, s: `Converting ${f.name}` });
            const r = await fileToPdf({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
            converted.push({ name: f.name, bytes: r.bytes, warnings: r.warnings });
          }
          if (converted.length > 1 && mode === "combined") {
            const merged = await mergeDocuments(converted.map((c) => ({ name: c.name, bytes: c.bytes })));
            out.push({ id: "merged", name: "combined.pdf", kind: "pdf", bytes: merged.bytes, detail: `${converted.length} documents combined (${merged.pageCount} pages)`, warnings: converted.flatMap((c) => c.warnings) });
          } else {
            for (const c of converted) out.push({ id: c.name, name: `${baseName(c.name)}.pdf`, kind: "pdf", bytes: c.bytes, detail: "Converted", warnings: c.warnings });
          }
        }
      }
      // Validate every output with a real parser before offering it.
      const validated: Result[] = [];
      for (const r of out) {
        const v = await verifyOutput(r.kind, r.bytes);
        if (!v.ok) throw new Error(`${r.name} failed validation: ${v.error}`);
        validated.push({ ...r, detail: `${r.detail} · verified (${v.detail})` });
      }
      setResults(validated);
      setProgress({ f: 100, s: "Done" });
      apiJson("/api/jobs", {
        method: "POST",
        body: JSON.stringify({ kind: `convert-${selected.id}`, fileName: files[0]?.name ?? active?.name ?? "document", inputSize: files.reduce((a, f) => a + f.size, 0), outputSize: validated.reduce((a, r) => a + r.bytes.length, 0), message: `${validated.length} output(s) validated` }),
      }).catch(() => undefined);
      notify("success", `${validated.length} file(s) created and validated.`);
    } catch (e) {
      const cancelled = (e as Error).name === "AbortError";
      const msg = cancelled ? "Conversion cancelled. No output was created." : e instanceof Error ? e.message : "Conversion failed.";
      setError(msg);
      if (!cancelled) notify("error", msg);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const groups: { id: Group; title: string; text: string }[] = [
    { id: "pdf-to", title: "PDF → other formats", text: "Export the PDF's text, tables, pages and images." },
    { id: "to-pdf", title: "Other files → PDF", text: "Turn Office files, text and images into PDFs. Several files can be combined." },
  ];

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8">
      <PageTitle
        title="Conversion center"
        description="Every output is generated in your browser and checked with a real parser before download. Layout-sensitive conversions are best-effort — review the result."
      />
      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <div className="space-y-5">
          <Card title="1. Choose input" icon={<FileDown size={18} aria-hidden />}>
            <Dropzone
              multiple
              accept={ACCEPT}
              title="Drop files or click to choose"
              hint="PDF, DOCX, XLSX, PPTX, TXT, MD, HTML, PNG, JPEG, TIFF"
              onFiles={(f) => {
                setFiles((prev) => [...prev, ...f]);
                setResults([]);
              }}
              compact
            />
            {files.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2 py-1.5 dark:bg-slate-800">
                    <span className="truncate">{f.name}</span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
                      {formatBytes(f.size)}
                      <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, k) => k !== i))} className="rounded p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700"><X size={12} /></button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {active && (
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={useDoc} onChange={(e) => setUseDoc(e.target.checked)} />
                Use the open document ({active.name})
              </label>
            )}
            {files.length > 0 && (
              <Button size="sm" variant="ghost" className="mt-2" onClick={() => setFiles([])}>Clear files</Button>
            )}
          </Card>

          <Card title="2. Options" icon={<FileText size={18} aria-hidden />}>
            {!selected && <p className="text-sm text-slate-500">Choose a conversion on the right.</p>}
            {selected && (
              <div className="space-y-3 text-sm">
                <p className="font-semibold">{selected.label}</p>
                <p className="text-slate-600 dark:text-slate-300">{selected.desc}</p>
                {selected.options === "docx" && (
                  <label className="block"><span className={labelCls}>Mode</span>
                    <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value)}>
                      <option value="editable">Editable text (recommended)</option>
                      <option value="layout">Layout-preserving (page images, not editable)</option>
                    </select>
                  </label>
                )}
                {selected.options === "xlsx" && (
                  <label className="block"><span className={labelCls}>Worksheets</span>
                    <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value)}>
                      <option value="perTable">One sheet per table</option>
                      <option value="single">One combined sheet</option>
                    </select>
                  </label>
                )}
                {selected.options === "pptx" && (
                  <label className="block"><span className={labelCls}>Slide content</span>
                    <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value)}>
                      <option value="editable">Editable text and tables</option>
                      <option value="image">Page images (high fidelity)</option>
                    </select>
                  </label>
                )}
                {selected.options === "raster" && (
                  <label className="block"><span className={labelCls}>Resolution</span>
                    <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value)}>
                      <option value="low">Low (72 dpi)</option>
                      <option value="medium">Medium (144 dpi)</option>
                      <option value="high">High (216 dpi)</option>
                    </select>
                  </label>
                )}
                {selected.options === "tiff" && (
                  <label className="block"><span className={labelCls}>Resolution</span>
                    <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value)}>
                      <option value="low">Low (72 dpi)</option>
                      <option value="medium">Medium (144 dpi)</option>
                      <option value="high">High (216 dpi)</option>
                    </select>
                  </label>
                )}
                {selected.group === "to-pdf" && (
                  <label className="block"><span className={labelCls}>Multiple inputs</span>
                    <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value)}>
                      <option value="separate">One PDF per file</option>
                      <option value="combined">Combine into one PDF</option>
                    </select>
                  </label>
                )}
                {selected.note && <Notice tone={selected.status === "ready" ? "info" : "warn"}>{selected.note}</Notice>}
                {selected.status === "needs-ocr" && <Button size="sm" onClick={() => (window.location.href = "/ocr")}>Go to OCR</Button>}
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button variant="primary" onClick={run} disabled={busy || !hasSource && selected.group === "pdf-to" && !active} title={!hasSource ? "Choose input files first" : undefined}>
                    {busy ? <Spinner label="Converting…" /> : "Convert"}
                  </Button>
                  {busy && <Button variant="danger" onClick={() => abortRef.current?.abort()}>Cancel</Button>}
                </div>
                {busy && <ProgressBar value={progress.f} label={progress.s} />}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex flex-1 items-center gap-2 rounded-xl border bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
              <Search size={16} className="text-slate-400" aria-hidden />
              <span className="sr-only">Search conversions</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search formats (e.g. Excel, PNG)" className="w-full bg-transparent text-sm outline-none" />
            </label>
          </div>
          {groups.map((g) => (
            <section key={g.id} aria-labelledby={`g-${g.id}`}>
              <h2 id={`g-${g.id}`} className="text-lg font-black">{g.title}</h2>
              <p className="mb-3 text-sm text-slate-500">{g.text}</p>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {filteredOps.filter((o) => o.group === g.id).map((o) => {
                  const I = o.icon;
                  const active_ = selected?.id === o.id;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      aria-pressed={active_}
                      onClick={() => {
                        setSelected(o);
                        setMode(o.options === "docx" ? "editable" : o.options === "xlsx" ? "perTable" : o.options === "pptx" ? "editable" : o.group === "to-pdf" ? "separate" : "medium");
                        setResults([]);
                        setError(null);
                      }}
                      className={cn("flex items-start gap-3 rounded-xl border bg-white p-4 text-left transition hover:shadow-md dark:bg-slate-900", active_ ? "border-blue-600 ring-2 ring-blue-200" : "border-slate-200 dark:border-slate-700")}
                    >
                      <span className="rounded-lg bg-blue-50 p-2 text-blue-600 dark:bg-blue-950/40"><I size={18} aria-hidden /></span>
                      <span className="min-w-0">
                        <span className="block font-semibold">{o.label}</span>
                        <span className="block text-xs text-slate-500 dark:text-slate-400">{o.desc}</span>
                        {o.status === "unsupported" && <span className="mt-1 inline-block rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-200">Not available</span>}
                        {o.status === "needs-ocr" && <span className="mt-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">Needs OCR</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}

          {error && <Notice tone="error">{error}</Notice>}

          {results.length > 0 && (
            <Card title="Results" icon={<FileDown size={18} aria-hidden />} actions={
              <Button size="sm" onClick={() => results.forEach((r) => downloadBytes(r.bytes, r.name, MIME_TYPES[r.kind] ?? "application/octet-stream"))}>Download all</Button>
            }>
              <ul className="divide-y dark:divide-slate-700">
                {results.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{r.name}</p>
                      <p className="text-xs text-slate-500">{formatBytes(r.bytes.length)} · {MIME_TYPES[r.kind]} · .{EXTENSIONS[r.kind]} · {r.detail}</p>
                      {r.warnings.map((w, i) => <p key={i} className="text-xs text-amber-700 dark:text-amber-300">⚠ {w}</p>)}
                    </div>
                    <Button size="sm" variant="primary" onClick={() => downloadBytes(r.bytes, r.name, MIME_TYPES[r.kind])}>Download</Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Notice>
            <b>Honest limits:</b> PDFs without a text layer (scans) produce empty text outputs — run OCR first. Multi-column magazine layouts and designed graphics are simplified. Legacy binary Office files and PDF/A are not converted in this build.
          </Notice>
        </div>
      </div>
    </div>
  );
}

