"use client";

import { useState } from "react";
import JSZip from "jszip";
import { ArrowDown, ArrowUp, Download, Layers, Minimize2, Split, Stamp, Trash2, Wrench } from "lucide-react";
import { useWorkspace } from "@/lib/store";
import { Button, Card, Dropzone, Notice, PageTitle, ProgressBar, Spinner, cn, inputCls, labelCls } from "@/components/ui";
import { apiJson, baseName, downloadBytes, formatBytes } from "@/lib/browser";
import { openPdf, releasePdf } from "@/lib/pdf/pdfjs";
import { decorateDocument, losslessOptimize, mergeDocuments, rotatePages, splitByRanges, splitEachPage, type NamedBytes } from "@/lib/pdf/operations";
import { PRESETS, rasterCompress, type Preset } from "@/lib/pdf/compress";
import { MIME_TYPES, verifyOutput } from "@/lib/pdf/validate";

type Tab = "merge" | "split" | "compress" | "batch";

type Out = { name: string; bytes: Uint8Array; detail: string };

async function zipOf(items: NamedBytes[]): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const i of items) zip.file(i.name, i.bytes);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function log(kind: string, name: string, input: number, output: number, message: string) {
  apiJson("/api/jobs", { method: "POST", body: JSON.stringify({ kind, fileName: name, inputSize: input, outputSize: output, message }) }).catch(() => undefined);
}

export default function ToolsPanel() {
  const { active, notify } = useWorkspace();
  const [tab, setTab] = useState<Tab>("merge");
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [status, setStatus] = useState("");
  const [outs, setOuts] = useState<Out[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Merge
  const [mergeFiles, setMergeFiles] = useState<File[]>([]);
  // Split
  const [splitFile, setSplitFile] = useState<File | null>(null);
  const [splitMode, setSplitMode] = useState<"ranges" | "each">("ranges");
  const [ranges, setRanges] = useState("1-2, 3");
  // Compress
  const [compressFiles, setCompressFiles] = useState<File[]>([]);
  const [preset, setPreset] = useState<Preset | "lossless">("medium");
  // Batch
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [batchOp, setBatchOp] = useState<"rotate" | "watermark" | "numbers" | "lossless" | "text">("rotate");
  const [watermark, setWatermark] = useState("DRAFT");
  const [batchState, setBatchState] = useState<Record<string, string>>({});

  const start = (label: string) => {
    setBusy(true);
    setError(null);
    setOuts([]);
    setPct(0);
    setStatus(label);
  };
  const finish = () => {
    setBusy(false);
    setStatus("");
    setPct(100);
  };
  const fail = (e: unknown) => {
    const msg = e instanceof Error ? e.message : "The operation failed.";
    setError(msg);
    notify("error", msg);
  };


  const doMerge = async () => {
    if (mergeFiles.length < 2) {
      setError("Add at least two PDF files to merge.");
      return;
    }
    start("Merging");
    try {
      const inputs: NamedBytes[] = [];
      for (const f of mergeFiles) inputs.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      const r = await mergeDocuments(inputs);
      const check = await verifyOutput("pdf", r.bytes);
      if (!check.ok) throw new Error(check.error);
      const total = mergeFiles.reduce((a, f) => a + f.size, 0);
      setOuts([{ name: "merged.pdf", bytes: r.bytes, detail: `${r.pageCount} pages · ${check.detail}` }]);
      log("merge", `${mergeFiles.length} files`, total, r.bytes.length, `${r.pageCount} pages`);
    } catch (e) {
      fail(e);
    } finally {
      finish();
    }
  };

  const doSplit = async () => {
    const source = splitFile ? new Uint8Array(await splitFile.arrayBuffer()) : null;
    const name = splitFile?.name ?? active?.name;
    const bytes = source ?? (active ? new Uint8Array(active.bytes.slice(0)) : null);
    if (!bytes || !name) {
      setError("Choose a PDF to split, or open one in the editor.");
      return;
    }
    start("Splitting");
    try {
      const base = baseName(name);
      const parts = splitMode === "each" ? await splitEachPage(bytes, base) : await splitByRanges(bytes, ranges, base);
      const checked: NamedBytes[] = [];
      for (const p of parts) {
        const v = await verifyOutput("pdf", p.bytes);
        if (!v.ok) throw new Error(`${p.name}: ${v.error}`);
        checked.push(p);
      }
      if (checked.length === 1) setOuts([{ name: checked[0].name, bytes: checked[0].bytes, detail: "Verified PDF" }]);
      else setOuts([{ name: `${base}-split.zip`, bytes: await zipOf(checked), detail: `${checked.length} verified PDFs in a ZIP` }]);
      log("split", name, bytes.length, checked.reduce((a, p) => a + p.bytes.length, 0), `${checked.length} part(s)`);
    } catch (e) {
      fail(e);
    } finally {
      finish();
    }
  };

  const doCompress = async () => {
    if (!compressFiles.length && !active) {
      setError("Choose PDF files to compress.");
      return;
    }
    start("Compressing");
    const results: Out[] = [];
    try {
      const sources = compressFiles.length ? compressFiles.map((f) => ({ name: f.name, bytes: f.arrayBuffer() })) : [{ name: active!.name, bytes: Promise.resolve(active!.bytes.slice(0)) }];
      for (let k = 0; k < sources.length; k++) {
        const s = sources[k];
        const buf = await s.bytes;
        const original = buf.byteLength;
        setStatus(`${s.name}`);
        let bytes: Uint8Array;
        let detail: string;
        if (preset === "lossless") {
          bytes = await losslessOptimize(new Uint8Array(buf));
          detail = "Lossless re-save: text and images unchanged";
        } else {
          const pdf = await openPdf(buf);
          bytes = await rasterCompress(pdf, preset, { onProgress: (f) => setPct(((k + f) / sources.length) * 100) });
          releasePdf(pdf);
          detail = `${PRESETS[preset].label}: page images re-encoded (text is not selectable)`;
        }
        const v = await verifyOutput("pdf", bytes);
        if (!v.ok) throw new Error(v.error);
        const change = bytes.length < original ? `${Math.round((1 - bytes.length / original) * 100)}% smaller` : "no reduction";
        if (bytes.length >= original) {
          results.push({ name: `${baseName(s.name)}-compressed.pdf`, bytes: new Uint8Array(buf), detail: `Original kept — compressed output would be ${formatBytes(bytes.length)} (larger). ${detail}` });
        } else {
          results.push({ name: `${baseName(s.name)}-compressed.pdf`, bytes, detail: `${formatBytes(original)} → ${formatBytes(bytes.length)} (${change}). ${detail}` });
        }
        log("compress", s.name, original, bytes.length, preset);
      }
      setOuts(results);
      setPct(100);
    } catch (e) {
      fail(e);
    } finally {
      finish();
    }
  };

  const doBatch = async () => {
    if (!batchFiles.length) {
      setError("Add PDFs for batch processing.");
      return;
    }
    setBusy(true);
    setError(null);
    setOuts([]);
    const state: Record<string, string> = {};
    batchFiles.forEach((f) => (state[f.name] = "queued"));
    setBatchState({ ...state });
    const produced: Out[] = [];
    for (let k = 0; k < batchFiles.length; k++) {
      const f = batchFiles[k];
      setPct((k / batchFiles.length) * 100);
      state[f.name] = "running";
      setBatchState({ ...state });
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        let out: Uint8Array;
        let name = `${baseName(f.name)}`;
        if (batchOp === "rotate") {
          out = await rotatePages(buf, 90);
          name += "-rotated.pdf";
        } else if (batchOp === "watermark") {
          out = await decorateDocument(buf, { watermark: { text: watermark || "DRAFT", opacity: 0.18 } });
          name += "-watermarked.pdf";
        } else if (batchOp === "numbers") {
          out = await decorateDocument(buf, { pageNumbers: true });
          name += "-numbered.pdf";
        } else if (batchOp === "lossless") {
          out = await losslessOptimize(buf);
          name += "-optimized.pdf";
        } else {
          const pdf = await openPdf(buf);
          const { extractLayout } = await import("@/lib/pdf/extract");
          const { toText } = await import("@/lib/pdf/convert-out");
          const pages = await extractLayout(pdf);
          releasePdf(pdf);
          out = new TextEncoder().encode(toText(pages));
          name += ".txt";
        }
        const v = await verifyOutput(batchOp === "text" ? "txt" : "pdf", out);
        if (!v.ok) throw new Error(v.error);
        produced.push({ name, bytes: out, detail: `${formatBytes(buf.length)} → ${formatBytes(out.length)}` });
        state[f.name] = "done";
      } catch (e) {
        state[f.name] = `error: ${e instanceof Error ? e.message : "failed"}`;
      }
      setBatchState({ ...state });
    }
    setOuts(produced);
    setPct(100);
    setBusy(false);
    log("batch", `${batchFiles.length} files`, batchFiles.reduce((a, f) => a + f.size, 0), produced.reduce((a, o) => a + o.bytes.length, 0), batchOp);
  };

  const tabs: { id: Tab; label: string; icon: typeof Layers }[] = [
    { id: "merge", label: "Merge", icon: Layers },
    { id: "split", label: "Split", icon: Split },
    { id: "compress", label: "Compress", icon: Minimize2 },
    { id: "batch", label: "Batch", icon: Wrench },
  ];

  const deliver = (o: Out) => downloadBytes(o.bytes, o.name, o.name.endsWith(".zip") ? "application/zip" : MIME_TYPES.pdf);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      <PageTitle title="Merge, split & compress" description="Work with several files at once. Every output is verified as a PDF or ZIP before download. Processing happens in your browser." />
      <div role="tablist" className="mb-5 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => { setTab(t.id); setError(null); setOuts([]); }} className={cn("flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold", tab === t.id ? "bg-blue-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200")}>
            <t.icon size={16} aria-hidden /> {t.label}
          </button>
        ))}
      </div>

      {tab === "merge" && (
        <Card title="Merge PDFs" icon={<Layers size={18} aria-hidden />}>
          <Dropzone multiple accept=".pdf,application/pdf" title="Add PDFs to merge" hint="Pages are appended in the order shown below." onFiles={(f) => setMergeFiles([...mergeFiles, ...f.filter((x) => /\.pdf$/i.test(x.name))])} compact />
          <ol className="mt-4 space-y-2">
            {mergeFiles.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800">
                <span className="truncate">{i + 1}. {f.name} <span className="text-xs text-slate-400">({formatBytes(f.size)})</span></span>
                <span className="flex gap-1">
                  <button type="button" aria-label={`Move ${f.name} up`} disabled={i === 0} onClick={() => { const n = [...mergeFiles]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setMergeFiles(n); }} className="rounded p-1 hover:bg-slate-200 disabled:opacity-30 dark:hover:bg-slate-700"><ArrowUp size={14} /></button>
                  <button type="button" aria-label={`Move ${f.name} down`} disabled={i === mergeFiles.length - 1} onClick={() => { const n = [...mergeFiles]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; setMergeFiles(n); }} className="rounded p-1 hover:bg-slate-200 disabled:opacity-30 dark:hover:bg-slate-700"><ArrowDown size={14} /></button>
                  <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setMergeFiles(mergeFiles.filter((_, k) => k !== i))} className="rounded p-1 text-red-600 hover:bg-red-50"><Trash2 size={14} /></button>
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-4 flex gap-2">
            <Button variant="primary" onClick={doMerge} disabled={busy || mergeFiles.length < 2}>{busy ? <Spinner label={status} /> : "Merge and verify"}</Button>
            {mergeFiles.length > 0 && <Button variant="ghost" onClick={() => setMergeFiles([])}>Clear</Button>}
          </div>
          <p className="mt-3 text-xs text-slate-500">Merging copies the pages of each file. Bookmarks and form fields of the inputs are not carried over in this version.</p>
        </Card>
      )}

      {tab === "split" && (
        <Card title="Split a PDF" icon={<Split size={18} aria-hidden />}>
          <Dropzone accept=".pdf,application/pdf" title={splitFile ? splitFile.name : "Choose a PDF to split"} hint={active ? `Or split the open document (${active.name}) by leaving this empty.` : undefined} onFiles={(f) => setSplitFile(f[0])} compact />
          <div className="mt-4 space-y-3 text-sm">
            <label className="flex items-center gap-2"><input type="radio" name="split" checked={splitMode === "ranges"} onChange={() => setSplitMode("ranges")} /> By page ranges</label>
            {splitMode === "ranges" && <input value={ranges} onChange={(e) => setRanges(e.target.value)} className={inputCls} aria-label="Page ranges" />}
            <label className="flex items-center gap-2"><input type="radio" name="split" checked={splitMode === "each"} onChange={() => setSplitMode("each")} /> Every page as its own PDF</label>
          </div>
          <Button variant="primary" className="mt-4" onClick={doSplit} disabled={busy}>{busy ? <Spinner label={status} /> : "Split and verify"}</Button>
        </Card>
      )}

      {tab === "compress" && (
        <Card title="Compress PDFs" icon={<Minimize2 size={18} aria-hidden />}>
          <Dropzone multiple accept=".pdf,application/pdf" title="Add PDFs to compress" onFiles={(f) => setCompressFiles([...compressFiles, ...f])} compact />
          {compressFiles.length > 0 && <p className="mt-2 text-xs text-slate-500">{compressFiles.length} file(s): {formatBytes(compressFiles.reduce((a, f) => a + f.size, 0))} total</p>}
          <fieldset className="mt-4 grid gap-2 md:grid-cols-2">
            <legend className={labelCls}>Compression</legend>
            {(["lossless", "low", "medium", "high"] as const).map((p) => (
              <label key={p} className={cn("flex cursor-pointer gap-3 rounded-xl border p-3 text-sm", preset === p ? "border-blue-600 bg-blue-50 dark:bg-blue-950/30" : "border-slate-200 dark:border-slate-700")}>
                <input type="radio" name="preset" className="mt-1" checked={preset === p} onChange={() => setPreset(p)} />
                <span>
                  <b className="capitalize">{p === "lossless" ? "Lossless optimization" : PRESETS[p].label}</b>
                  <span className="block text-xs text-slate-500">{p === "lossless" ? "Keeps text, images and searchability. Removes unused objects and uses compressed object streams. Savings are often small." : PRESETS[p].text}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" onClick={doCompress} disabled={busy}>{busy ? <Spinner label={status} /> : "Compress"}</Button>
            {!compressFiles.length && active && <span className="self-center text-xs text-slate-500">Will use the open document: {active.name}</span>}
          </div>
          {busy && <div className="mt-3"><ProgressBar value={pct} label={status} /></div>}
          <Notice tone="info">
            <span>We never claim a smaller file: if the result is not smaller, the original is offered and the reason is shown. Raster presets turn pages into images, so text can no longer be searched or selected.</span>
          </Notice>
        </Card>
      )}

      {tab === "batch" && (
        <Card title="Batch processing" icon={<Wrench size={18} aria-hidden />} actions={<span className="text-xs text-slate-500">{batchFiles.length} file(s)</span>}>
          <Dropzone multiple accept=".pdf,application/pdf" title="Add PDFs for batch processing" onFiles={(f) => setBatchFiles([...batchFiles, ...f])} compact />
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <label className="block text-sm"><span className={labelCls}>Operation</span>
              <select className={inputCls} value={batchOp} onChange={(e) => setBatchOp(e.target.value as typeof batchOp)}>
                <option value="rotate">Rotate every page 90° clockwise</option>
                <option value="watermark">Add a watermark</option>
                <option value="numbers">Add page numbers</option>
                <option value="lossless">Lossless optimization</option>
                <option value="text">Extract text (TXT)</option>
              </select>
            </label>
            {batchOp === "watermark" && (
              <label className="block text-sm"><span className={labelCls}>Watermark text</span>
                <input className={inputCls} value={watermark} onChange={(e) => setWatermark(e.target.value)} />
              </label>
            )}
          </div>
          <ul className="mt-4 space-y-1 text-sm">
            {batchFiles.map((f) => (
              <li key={f.name} className="flex justify-between gap-2 rounded-lg bg-slate-50 px-3 py-1.5 dark:bg-slate-800">
                <span className="truncate">{f.name}</span>
                <span className={cn("shrink-0 text-xs", batchState[f.name]?.startsWith("error") ? "text-red-600" : batchState[f.name] === "done" ? "text-emerald-600" : "text-slate-500")}>{batchState[f.name] ?? "ready"}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" onClick={doBatch} disabled={busy || !batchFiles.length}>{busy ? <Spinner label="Processing…" /> : <><Stamp size={14} /> Run batch</>}</Button>
            {outs.length > 0 && <Button variant="secondary" onClick={() => outs.forEach(deliver)}><Download size={14} /> Download all</Button>}
            {outs.length > 1 && <Button variant="secondary" onClick={async () => downloadBytes(await zipOf(outs.map((o) => ({ name: o.name, bytes: o.bytes }))), "batch-output.zip", "application/zip")}>Download ZIP</Button>}
          </div>
          {busy && <div className="mt-3"><ProgressBar value={pct} label="Batch progress" /></div>}
        </Card>
      )}

      {error && <div className="mt-5"><Notice tone="error">{error}</Notice></div>}

      {outs.length > 0 && tab !== "batch" && (
        <Card title="Result" className="mt-5">
          <ul className="space-y-2">
            {outs.map((o) => (
              <li key={o.name} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 dark:border-slate-700">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{o.name}</p>
                  <p className="text-xs text-slate-500">{formatBytes(o.bytes.length)} · {o.detail}</p>
                </div>
                <Button size="sm" variant="primary" onClick={() => deliver(o)}><Download size={14} /> Download</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {tab === "batch" && outs.length > 0 && (
        <Card title="Batch results" className="mt-5">
          <ul className="space-y-2">
            {outs.map((o) => (
              <li key={o.name} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{o.name} <span className="text-xs text-slate-500">({o.detail})</span></span>
                <Button size="sm" onClick={() => deliver(o)}>Download</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {busy && tab === "merge" && <div className="mt-3 text-sm text-slate-500">{status}</div>}
    </div>
  );
}
