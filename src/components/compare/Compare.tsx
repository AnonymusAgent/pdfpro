"use client";

import { useRef, useState } from "react";
import { GitCompare, Eye, FileText } from "lucide-react";
import { Button, Card, Dropzone, Notice, PageTitle, ProgressBar, Spinner, labelCls } from "@/components/ui";
import { getPageText, openPdf, rasterize, releasePdf } from "@/lib/pdf/pdfjs";
import { useWorkspace } from "@/lib/store";

const MAX_PAGES = 40;

type PageDiff = { page: number; changedPct: number; dataUrl: string; sizeA: string; sizeB: string };
type TextDiff = { kind: "same" | "add" | "del"; text: string }[];

/** Line-level LCS diff; limited to 2000 lines per side to bound memory. */
export function diffLines(a: string[], b: string[]): TextDiff {
  const n = Math.min(a.length, 2000);
  const m = Math.min(b.length, 2000);
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: TextDiff = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });
  return out;
}

async function pageImages(pdf: Awaited<ReturnType<typeof openPdf>>, index: number, scale: number) {
  const page = await pdf.getPage(index + 1);
  return rasterize(page, { scale, rotation: page.rotate });
}

export default function Compare() {
  const { active } = useWorkspace();
  const [fa, setFa] = useState<File | null>(null);
  const [fb, setFb] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [pages, setPages] = useState<PageDiff[]>([]);
  const [textDiff, setTextDiff] = useState<TextDiff | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const cancelled = useRef(false);

  const run = async () => {
    if (!fa || !fb) return setErr("Choose two PDF files to compare.");
    setErr(null);
    setBusy(true);
    setPages([]);
    setTextDiff(null);
    cancelled.current = false;
    try {
      const [pa, pb] = await Promise.all([openPdf(await fa.arrayBuffer()), openPdf(await fb.arrayBuffer())]);
      const count = Math.min(pa.numPages, pb.numPages, MAX_PAGES);
      const notes: string[] = [];
      if (pa.numPages !== pb.numPages) notes.push(`Page counts differ (${pa.numPages} vs ${pb.numPages}). Pages beyond ${count} are not compared visually.`);
      if (Math.max(pa.numPages, pb.numPages) > MAX_PAGES) notes.push(`Visual comparison is limited to the first ${MAX_PAGES} pages.`);

      // Text diff (line level).
      const textOf = async (pdf: typeof pa) => {
        const lines: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const t = await getPageText(await pdf.getPage(i));
          lines.push(...t.text.split(/(?<=[.!?])\s+|\n/).map((s) => s.trim()).filter(Boolean));
        }
        return lines;
      };
      const [la, lb] = await Promise.all([textOf(pa), textOf(pb)]);
      setTextDiff(diffLines(la, lb));

      // Visual diff.
      const out: PageDiff[] = [];
      for (let i = 0; i < count; i++) {
        if (cancelled.current) break;
        setPct(((i + 1) / count) * 100);
        const ca = await pageImages(pa, i, 1);
        const cb = await pageImages(pb, i, 1);
        const w = Math.max(ca.width, cb.width);
        const h = Math.max(ca.height, cb.height);
        const da = ca.getContext("2d")!.getImageData(0, 0, ca.width, ca.height).data;
        const db = cb.getContext("2d")!.getImageData(0, 0, cb.width, cb.height).data;
        const diffCanvas = document.createElement("canvas");
        diffCanvas.width = w;
        diffCanvas.height = h;
        const dctx = diffCanvas.getContext("2d")!;
        const outImg = dctx.createImageData(w, h);
        let changed = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            const inA = x < ca.width && y < ca.height;
            const inB = x < cb.width && y < cb.height;
            const ia = inA ? ((y * ca.width + x) * 4) : -1;
            const ib = inB ? ((y * cb.width + x) * 4) : -1;
            const ga = ia >= 0 ? (da[ia] + da[ia + 1] + da[ia + 2]) / 3 : 255;
            const gb = ib >= 0 ? (db[ib] + db[ib + 1] + db[ib + 2]) / 3 : 255;
            const differs = Math.abs(ga - gb) > 24;
            if (differs) {
              changed++;
              outImg.data[o] = 220;
              outImg.data[o + 1] = 38;
              outImg.data[o + 2] = 38;
            } else {
              const v = 255 - (ga * 0.25 + 191);
              outImg.data[o] = outImg.data[o + 1] = outImg.data[o + 2] = Math.max(0, Math.min(255, 255 - (255 - ga) * 0.25));
              void v;
            }
            outImg.data[o + 3] = 255;
          }
        }
        dctx.putImageData(outImg, 0, 0);
        const pctChanged = (changed / (w * h)) * 100;
        out.push({ page: i + 1, changedPct: pctChanged, dataUrl: diffCanvas.toDataURL("image/jpeg", 0.8), sizeA: `${ca.width}×${ca.height}`, sizeB: `${cb.width}×${cb.height}` });
        ca.width = ca.height = cb.width = cb.height = 0;
      }
      setPages(out);
      releasePdf(pa);
      releasePdf(pb);
      if (note === null) setNote(notes.join(" ") || null);
      setNote(notes.join(" ") || null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Comparison failed. Check that both files are valid PDFs.");
    } finally {
      setBusy(false);
      setPct(100);
    }
  };

  const shown = onlyChanged ? pages.filter((p) => p.changedPct > 0.01) : pages;
  const same = pages.length > 0 && pages.every((p) => p.changedPct <= 0.01);
  const diffs = textDiff ? textDiff.filter((d) => d.kind !== "same") : [];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      <PageTitle title="Compare PDFs" description="Visual comparison highlights changed pixels page by page. Text comparison lists sentences and lines present in only one file. Both run locally." />
      <div className="grid gap-5 md:grid-cols-2">
        {(["A", "B"] as const).map((k) => (
          <Card key={k} title={`Document ${k}`} icon={<FileText size={18} aria-hidden />}>
            <Dropzone accept=".pdf,application/pdf" title={(k === "A" ? fa : fb)?.name ?? `Choose PDF ${k}`} onFiles={(f) => (k === "A" ? setFa(f[0]) : setFb(f[0]))} compact />
            {k === "A" && active && <Button size="sm" variant="ghost" className="mt-2" onClick={() => active && (async () => setFa(new File([active.bytes], active.name, { type: "application/pdf" })))()}>Use open document</Button>}
          </Card>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={run} disabled={busy || !fa || !fb}>{busy ? <Spinner label="Comparing…" /> : <><GitCompare size={16} /> Compare</>}</Button>
        {busy && <Button variant="danger" onClick={() => (cancelled.current = true)}>Cancel</Button>}
        {pages.length > 0 && (
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> Show only changed pages</label>
        )}
      </div>
      {busy && <div className="mt-3"><ProgressBar value={pct} label="Comparing pages" /></div>}
      {err && <div className="mt-4"><Notice tone="error">{err}</Notice></div>}
      {note && <div className="mt-4"><Notice tone="warn">{note}</Notice></div>}
      {same && <div className="mt-4"><Notice tone="success">The compared pages are visually identical (within a small colour tolerance).</Notice></div>}

      {pages.length > 0 && (
        <section className="mt-6 space-y-4" aria-label="Visual differences">
          <h2 className="flex items-center gap-2 text-lg font-bold"><Eye size={18} aria-hidden /> Visual differences</h2>
          <p className="text-xs text-slate-500">Red pixels differ between the two files. Grey shows unchanged content.</p>
          {shown.map((p) => (
            <figure key={p.page} className="rounded-xl border bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
              <figcaption className="mb-2 flex justify-between text-sm"><b>Page {p.page}</b><span className={p.changedPct > 0.01 ? "text-red-600" : "text-emerald-600"}>{p.changedPct.toFixed(2)}% changed</span></figcaption>
              <img src={p.dataUrl} alt={`Differences on page ${p.page}`} className="mx-auto max-h-[70vh] w-auto max-w-full rounded" />
            </figure>
          ))}
        </section>
      )}

      {textDiff && (
        <section className="mt-6" aria-label="Text differences">
          <h2 className="text-lg font-bold">Text differences</h2>
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">{diffs.length === 0 ? "No text differences found." : `${diffs.filter((d) => d.kind === "del").length} line(s) only in A, ${diffs.filter((d) => d.kind === "add").length} only in B.`} Scanned pages have no text and are compared visually only.</p>
          <div className="grid gap-3 md:grid-cols-2">
            <div className={labelCls}>Only in A
              <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-red-50 p-3 text-xs text-slate-800 dark:bg-red-950/30 dark:text-slate-200">{diffs.filter((d) => d.kind === "del").map((d) => d.text).join("\n") || "—"}</pre>
            </div>
            <div className={labelCls}>Only in B
              <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-emerald-50 p-3 text-xs text-slate-800 dark:bg-emerald-950/30 dark:text-slate-200">{diffs.filter((d) => d.kind === "add").map((d) => d.text).join("\n") || "—"}</pre>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
