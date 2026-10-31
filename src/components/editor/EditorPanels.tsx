"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { Bookmark, Copy, Download, FilePlus2, FileText, MessageSquare, Paperclip, RotateCw, Trash2, Layers } from "lucide-react";
import { normRot } from "@/lib/pdf/geometry";
import { thumbnailDataUrl, type OutlineNode } from "@/lib/pdf/pdfjs";
import type { ExportOptions } from "@/lib/pdf/export";
import type { Ann, Box, PageEntry } from "@/lib/pdf/types";
import { Button, Modal, inputCls, labelCls, cn } from "@/components/ui";
import { formatBytes } from "@/lib/browser";

/* ------------------------------------------------------------ thumbnails */

function Thumb({
  docId,
  entry,
  index,
  pdf,
  current,
  checked,
  onCheck,
  onGo,
  onRotate,
  onDuplicate,
  onDelete,
  onDragStart,
  onDropHere,
}: {
  docId: string;
  entry: PageEntry;
  index: number;
  pdf: PDFDocumentProxy | null;
  current: boolean;
  checked: boolean;
  onCheck: (v: boolean) => void;
  onGo: () => void;
  onRotate: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDropHere: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !pdf || entry.src === "blank") return;
    let alive = true;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        pdf
          .getPage(entry.index + 1)
          .then((page) => thumbnailDataUrl(page, `${docId}:${entry.src}:${entry.index}`, normRot(page.rotate + entry.rot), 150))
          .then((u) => {
            if (alive) setUrl(u);
          })
          .catch(() => undefined);
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [pdf, entry.index, entry.src, entry.rot, docId]);

  return (
    <div
      ref={ref}
      draggable
      onDragStart={(e: DragEvent) => {
        e.dataTransfer.setData("text/plain", String(index));
        onDragStart();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDropHere();
      }}
      className={cn("group rounded-xl border bg-white p-1.5 dark:bg-slate-900", current ? "border-blue-600 ring-2 ring-blue-200" : "border-slate-200 dark:border-slate-700")}
    >
      <button type="button" onClick={onGo} className="block w-full" aria-label={`Go to page ${index + 1}`} aria-current={current ? "true" : undefined}>
        {entry.src === "blank" ? (
          <div className="grid h-[110px] place-items-center rounded bg-white text-[11px] text-slate-400 ring-1 ring-slate-200">Blank page</div>
        ) : url ? (
          <img src={url} alt="" className="w-full rounded ring-1 ring-slate-200" />
        ) : (
          <div className="grid h-[110px] place-items-center rounded bg-slate-100 text-[11px] text-slate-400 dark:bg-slate-800">Page {index + 1}</div>
        )}
      </button>
      <div className="mt-1 flex items-center justify-between gap-1 text-[11px]">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} aria-label={`Select page ${index + 1} for extraction`} />
          {index + 1}
          {entry.rot ? <span className="text-slate-400">· {entry.rot}°</span> : null}
          {entry.crop ? <span className="text-slate-400">· cropped</span> : null}
        </label>
        <span className="flex gap-0.5">
          <button type="button" title="Rotate 90° clockwise" aria-label={`Rotate page ${index + 1}`} onClick={onRotate} className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800">
            <RotateCw size={12} />
          </button>
          <button type="button" title="Duplicate page" aria-label={`Duplicate page ${index + 1}`} onClick={onDuplicate} className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800">
            <Copy size={12} />
          </button>
          <button type="button" title="Delete page" aria-label={`Delete page ${index + 1}`} onClick={onDelete} className="rounded p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950">
            <Trash2 size={12} />
          </button>
        </span>
      </div>
    </div>
  );
}

export function PagesPanel(props: {
  docId: string;
  entries: PageEntry[];
  pdfs: Record<string, PDFDocumentProxy>;
  current: number;
  onGo: (i: number) => void;
  onRotate: (i: number) => void;
  onDuplicate: (i: number) => void;
  onDelete: (i: number) => void;
  onMove: (from: number, to: number) => void;
  onInsertBlank: () => void;
  onInsertFile: () => void;
  onReplaceFile: () => void;
  onExtract: (indexes: number[]) => void;
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const from = useRef<number | null>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-2 gap-1 border-b p-2 text-xs dark:border-slate-700">
        <Button size="sm" onClick={props.onInsertBlank} className="col-span-1"><FilePlus2 size={13} /> Blank</Button>
        <Button size="sm" onClick={props.onInsertFile}>Insert file</Button>
        <Button size="sm" onClick={props.onReplaceFile}>Replace page</Button>
        <Button size="sm" disabled={!picked.size} onClick={() => props.onExtract([...picked].sort((a, b) => a - b))}>
          <Download size={13} /> Extract ({picked.size})
        </Button>
      </div>
      <p className="px-3 pt-2 text-[11px] text-slate-500">Drag thumbnails to reorder. Tick pages, then extract.</p>
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {props.entries.map((e, i) => (
          <Thumb
            key={e.uid}
            docId={props.docId}
            entry={e}
            index={i}
            pdf={e.src === "blank" ? null : (props.pdfs[e.src] ?? null)}
            current={props.current === i}
            checked={picked.has(i)}
            onCheck={(v) =>
              setPicked((prev) => {
                const n = new Set(prev);
                if (v) n.add(i);
                else n.delete(i);
                return n;
              })
            }
            onGo={() => props.onGo(i)}
            onRotate={() => props.onRotate(i)}
            onDuplicate={() => props.onDuplicate(i)}
            onDelete={() => props.onDelete(i)}
            onDragStart={() => (from.current = i)}
            onDropHere={() => {
              if (from.current !== null && from.current !== i) props.onMove(from.current, i);
              from.current = null;
            }}
          />
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- outline etc. */

export function OutlinePanel({ outline, onGo }: { outline: OutlineNode[] | null; onGo: (srcPage: number) => void }) {
  if (outline === null) return <p className="p-3 text-xs text-slate-500">Loading outline…</p>;
  if (!outline.length) return <p className="p-3 text-xs text-slate-500">This document has no bookmarks (outline).</p>;
  const render = (nodes: OutlineNode[], depth: number): React.ReactNode =>
    nodes.map((n, i) => (
      <div key={`${depth}-${i}-${n.title}`}>
        <button
          type="button"
          disabled={n.page === null}
          onClick={() => n.page !== null && onGo(n.page)}
          className="flex w-full items-center gap-2 truncate rounded px-2 py-1.5 text-left text-xs hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800"
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          <Bookmark size={12} className="shrink-0 text-blue-600" aria-hidden />
          <span className="truncate">{n.title}</span>
          {n.page !== null && <span className="ml-auto text-slate-400">p.{n.page + 1}</span>}
        </button>
        {n.children.length > 0 && render(n.children, depth + 1)}
      </div>
    ));
  return <div className="p-1">{render(outline, 0)}</div>;
}

export function NotesPanel({ anns, entries, onSelect }: { anns: Ann[]; entries: PageEntry[]; onSelect: (a: Ann, pageIndex: number) => void }) {
  const items = anns.filter((a) => ["note", "text", "stamp", "replace", "redact", "field", "link"].includes(a.type));
  if (!items.length) return <p className="p-3 text-xs text-slate-500">No comments, stamps or text overlays yet. Choose the Note or Stamp tool and click a page.</p>;
  return (
    <div className="space-y-2 p-2">
      {items.map((a) => {
        const pageIndex = entries.findIndex((e) => e.uid === a.uid);
        return (
          <button key={a.id} type="button" onClick={() => onSelect(a, pageIndex)} className="w-full rounded-lg border border-yellow-200 bg-yellow-50 p-2 text-left text-xs hover:border-yellow-400 dark:border-yellow-900 dark:bg-yellow-950/30">
            <span className="flex items-center gap-1 font-semibold capitalize"><MessageSquare size={11} aria-hidden /> {a.type}</span>
            <span className="line-clamp-3 block text-slate-700 dark:text-slate-200">{a.text || "(empty)"}</span>
            <span className="text-[10px] text-slate-400">Page {pageIndex + 1}</span>
          </button>
        );
      })}
    </div>
  );
}

export function FilesPanel(props: {
  name: string;
  size: number;
  pageCount: number;
  annCount: number;
  attachments: { name: string; bytes: Uint8Array }[] | null;
  onDownload: (a: { name: string; bytes: Uint8Array }) => void;
}) {
  return (
    <div className="space-y-3 p-3 text-xs text-slate-700 dark:text-slate-300">
      <div className="rounded-lg bg-slate-50 p-2 dark:bg-slate-800">
        <p className="flex items-center gap-1 font-semibold"><FileText size={12} aria-hidden /> {props.name}</p>
        <p>{props.pageCount} pages • {formatBytes(props.size)} • {props.annCount} annotations</p>
      </div>
      <div>
        <p className="mb-1 flex items-center gap-1 font-semibold"><Paperclip size={12} aria-hidden /> Embedded files</p>
        {props.attachments === null && <p className="text-slate-500">Checking…</p>}
        {props.attachments?.length === 0 && <p className="text-slate-500">No embedded files in this PDF.</p>}
        {props.attachments?.map((a) => (
          <div key={a.name} className="mb-1 flex items-center justify-between gap-2 rounded border p-2 dark:border-slate-700">
            <span className="truncate">{a.name}</span>
            <Button size="sm" onClick={() => props.onDownload(a)}>Save</Button>
          </div>
        ))}
      </div>
      <p className="flex items-start gap-1 text-slate-500"><Layers size={12} className="mt-0.5 shrink-0" aria-hidden /> Optional-content layer toggles are not available in this version; layers are rendered as stored in the file.</p>
    </div>
  );
}

/* ---------------------------------------------------------- properties */

export function PropertiesPanel(props: {
  ann: Ann | null;
  page: { index: number; total: number; W0: number; H0: number; rot: number; crop: Box | null; uid: string } | null;
  onPatch: (patch: Partial<Ann>, mode: "gesture" | "commit") => void;
  onEnd: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onRotatePage: () => void;
  onClearCrop: () => void;
  onInsertDate: () => void;
  onMoveLayer: (dir: "front" | "back") => void;
}) {
  const a = props.ann;
  const p = props.page;
  if (!a) {
    return (
      <div className="space-y-4 text-sm">
        <h3 className="font-bold">Page</h3>
        {p ? (
          <div className="space-y-2 text-xs text-slate-600 dark:text-slate-300">
            <p>Page {p.index + 1} of {p.total}</p>
            <p>Size {Math.round(p.W0)} × {Math.round(p.H0)} pt • Rotation {p.rot}°</p>
            <p>{p.crop ? "Crop box is set (export applies it)." : "No crop box."}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={props.onRotatePage}><RotateCw size={12} /> Rotate 90°</Button>
              {p.crop && <Button size="sm" onClick={props.onClearCrop}>Clear crop</Button>}
              <Button size="sm" onClick={props.onInsertDate}>Insert date</Button>
            </div>
          </div>
        ) : null}
        <p className="text-xs text-slate-500">Select an annotation to edit its font, size, colour, opacity, position and size. Press Delete to remove it. Use Ctrl/Cmd+Z to undo any change.</p>
      </div>
    );
  }
  const pt = (v: number, size: number) => Math.round(v * size * 10) / 10;
  const W0 = p?.W0 ?? 612;
  const H0 = p?.H0 ?? 792;
  const textual = ["text", "note", "replace", "stamp", "field", "link"].includes(a.type);
  const num = (label: string, value: number, onChange: (v: number) => void) => (
    <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
      {label}
      <input type="number" step="0.5" value={value} onChange={(e) => onChange(Number(e.target.value))} onBlur={props.onEnd} className={cn(inputCls, "mt-0.5 py-1")} />
    </label>
  );
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="font-bold capitalize">{a.type}</h3>
        <span className="text-[11px] text-slate-500">Page {(p?.index ?? 0) + 1}</span>
      </div>
      {textual && (
        <label className="block">
          <span className={labelCls}>Text</span>
          <textarea
            rows={3}
            value={a.text ?? ""}
            onFocus={() => undefined}
            onChange={(e) => props.onPatch({ text: e.target.value }, "gesture")}
            onBlur={props.onEnd}
            className={inputCls}
          />
        </label>
      )}
      {a.type === "link" && (
        <label className="block">
          <span className={labelCls}>Link address (http, https or mailto)</span>
          <input value={a.url ?? ""} placeholder="https://example.com" onChange={(e) => props.onPatch({ url: e.target.value }, "gesture")} onBlur={props.onEnd} className={inputCls} />
        </label>
      )}
      {textual && (
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Font
            <select value={a.font ?? "helvetica"} onChange={(e) => props.onPatch({ font: e.target.value as Ann["font"] }, "commit")} className={cn(inputCls, "mt-0.5 py-1")}>
              <option value="helvetica">Sans (Helvetica)</option>
              <option value="times">Serif (Times)</option>
              <option value="courier">Mono (Courier)</option>
            </select>
          </label>
          <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Align
            <select value={a.align ?? "left"} onChange={(e) => props.onPatch({ align: e.target.value as Ann["align"] }, "commit")} className={cn(inputCls, "mt-0.5 py-1")}>
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </label>
          <div className="flex gap-1">
            <button type="button" aria-pressed={!!a.bold} onClick={() => props.onPatch({ bold: !a.bold }, "commit")} className={cn("flex-1 rounded border py-1 text-xs font-bold", a.bold && "bg-blue-600 text-white")}>B</button>
            <button type="button" aria-pressed={!!a.italic} onClick={() => props.onPatch({ italic: !a.italic }, "commit")} className={cn("flex-1 rounded border py-1 text-xs italic", a.italic && "bg-blue-600 text-white")}>I</button>
          </div>
          <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Size {a.fontSize}pt
            <input type="range" min={6} max={72} value={a.fontSize} onChange={(e) => props.onPatch({ fontSize: Number(e.target.value) }, "gesture")} onPointerUp={props.onEnd} onKeyUp={props.onEnd} className="w-full" />
          </label>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Colour
          <input type="color" value={a.color.startsWith("#") ? a.color : "#111111"} onChange={(e) => props.onPatch({ color: e.target.value }, "commit")} className="mt-0.5 h-8 w-full rounded" />
        </label>
        {(a.type === "rect" || a.type === "ellipse" || a.type === "note" || a.type === "text" || a.type === "replace") && (
          <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Fill
            <input type="color" value={a.fill && a.fill.startsWith("#") ? a.fill : "#ffffff"} onChange={(e) => props.onPatch({ fill: e.target.value }, "commit")} className="mt-0.5 h-8 w-full rounded" />
          </label>
        )}
      </div>
      <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300">Opacity {Math.round(a.opacity * 100)}%
        <input type="range" min={5} max={100} value={Math.round(a.opacity * 100)} onChange={(e) => props.onPatch({ opacity: Number(e.target.value) / 100 }, "gesture")} onPointerUp={props.onEnd} onKeyUp={props.onEnd} className="w-full" />
      </label>
      {["rect", "ellipse", "line", "arrow", "draw", "underline", "strike"].includes(a.type) && (
        <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300">Line width {a.strokeWidth ?? 1.5}pt
          <input type="range" min={0.5} max={12} step={0.5} value={a.strokeWidth ?? 1.5} onChange={(e) => props.onPatch({ strokeWidth: Number(e.target.value) }, "gesture")} onPointerUp={props.onEnd} onKeyUp={props.onEnd} className="w-full" />
        </label>
      )}
      {(a.type === "image" || a.type === "signature") && (
        <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300">Rotation {a.rotation ?? 0}°
          <input type="range" min={0} max={359} value={a.rotation ?? 0} onChange={(e) => props.onPatch({ rotation: Number(e.target.value) }, "gesture")} onPointerUp={props.onEnd} onKeyUp={props.onEnd} className="w-full" />
        </label>
      )}
      <div className="grid grid-cols-2 gap-2">
        {num("X (pt)", pt(a.x, W0), (v) => props.onPatch({ x: v / W0 }, "gesture"))}
        {num("Y (pt)", pt(a.y, H0), (v) => props.onPatch({ y: v / H0 }, "gesture"))}
        {num("Width (pt)", pt(a.w, W0), (v) => props.onPatch({ w: v / W0 }, "gesture"))}
        {num("Height (pt)", pt(a.h, H0), (v) => props.onPatch({ h: v / H0 }, "gesture"))}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <Button size="sm" onClick={() => props.onMoveLayer("front")}>Bring to front</Button>
        <Button size="sm" onClick={() => props.onMoveLayer("back")}>Send to back</Button>
        <Button size="sm" onClick={props.onDuplicate}><Copy size={12} /> Duplicate</Button>
        <Button size="sm" variant="danger" onClick={props.onDelete}><Trash2 size={12} /> Delete</Button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- export dialog */

export function ExportDialog(props: {
  open: boolean;
  onClose: () => void;
  name: string;
  redactionCount: number;
  onRun: (opts: ExportOptions, secure: boolean) => void;
}) {
  const [paper, setPaper] = useState<"original" | "A4" | "Letter" | "Legal" | "A3">("original");
  const [landscape, setLandscape] = useState(false);
  const [margin, setMargin] = useState(0);
  const [background, setBackground] = useState("");
  const [watermark, setWatermark] = useState("");
  const [header, setHeader] = useState("");
  const [footer, setFooter] = useState("");
  const [pageNumbers, setPageNumbers] = useState(false);
  const [bates, setBates] = useState("");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [sanitize, setSanitize] = useState(false);
  const [protect, setProtect] = useState(false);
  const [owner, setOwner] = useState("");
  const [user, setUser] = useState("");
  const [perm, setPerm] = useState({ printing: true, copying: true, modifying: true, annotating: true, fillingForms: true });
  const [error, setError] = useState("");

  const build = (): ExportOptions | null => {
    if (protect && owner.length < 4) {
      setError("The owner password must be at least 4 characters.");
      return null;
    }
    setError("");
    return {
      paperSize: paper,
      landscape,
      marginPt: margin,
      background: background || null,
      watermark: watermark ? { text: watermark, opacity: 0.18 } : null,
      headerText: header || undefined,
      footerText: footer || undefined,
      pageNumbers,
      batesPrefix: bates || undefined,
      metadata: { title: title || undefined, author: author || undefined },
      sanitizeMetadata: sanitize,
      encrypt: protect ? { ownerPassword: owner, userPassword: user || undefined, permissions: perm } : null,
    };
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="Export PDF"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              const o = build();
              if (o) props.onRun(o, false);
            }}
          >
            <Download size={14} /> Export edited PDF
          </Button>
          <Button
            variant="dark"
            disabled={props.redactionCount === 0}
            title={props.redactionCount ? "Rasterizes redacted pages so the covered text cannot be extracted" : "Add redaction marks first (Redact tool)"}
            onClick={() => {
              const o = build();
              if (o) props.onRun(o, true);
            }}
          >
            Apply secure redaction &amp; export ({props.redactionCount})
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-2">
        <section className="space-y-3">
          <h3 className="font-bold">Layout</h3>
          <label className="block"><span className={labelCls}>Paper size</span>
            <select value={paper} onChange={(e) => setPaper(e.target.value as typeof paper)} className={inputCls}>
              <option value="original">Keep original sizes</option>
              <option value="A4">A4</option><option value="A3">A3</option><option value="Letter">US Letter</option><option value="Legal">US Legal</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={landscape} onChange={(e) => setLandscape(e.target.checked)} disabled={paper === "original"} /> Landscape</label>
            <label className="block text-xs"><span className={labelCls}>Margin (pt)</span><input type="number" min={0} max={200} value={margin} onChange={(e) => setMargin(Number(e.target.value))} className={inputCls} /></label>
          </div>
          <label className="block"><span className={labelCls}>Page background colour (when resizing)</span><input type="color" value={background || "#ffffff"} onChange={(e) => setBackground(e.target.value)} className="h-9 w-full rounded" /></label>
          <h3 className="pt-2 font-bold">Stamps &amp; numbering</h3>
          <label className="block"><span className={labelCls}>Watermark text</span><input value={watermark} onChange={(e) => setWatermark(e.target.value)} className={inputCls} placeholder="CONFIDENTIAL" /></label>
          <label className="block"><span className={labelCls}>Header text</span><input value={header} onChange={(e) => setHeader(e.target.value)} className={inputCls} /></label>
          <label className="block"><span className={labelCls}>Footer text</span><input value={footer} onChange={(e) => setFooter(e.target.value)} className={inputCls} /></label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={pageNumbers} onChange={(e) => setPageNumbers(e.target.checked)} /> Page numbers (“n / total”)</label>
          <label className="block"><span className={labelCls}>Bates prefix</span><input value={bates} onChange={(e) => setBates(e.target.value)} className={inputCls} placeholder="CASE-" /></label>
        </section>
        <section className="space-y-3">
          <h3 className="font-bold">Document properties</h3>
          <label className="block"><span className={labelCls}>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} /></label>
          <label className="block"><span className={labelCls}>Author</span><input value={author} onChange={(e) => setAuthor(e.target.value)} className={inputCls} /></label>
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={sanitize} onChange={(e) => setSanitize(e.target.checked)} className="mt-0.5" /> Remove creator and producer details from the output</label>
          <h3 className="pt-2 font-bold">Password protection</h3>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} /> Encrypt with AES-256 (standard PDF security)</label>
          {protect && (
            <div className="space-y-2 rounded-lg border p-3 dark:border-slate-700">
              <label className="block"><span className={labelCls}>Owner password (full control)</span><input type="password" value={owner} onChange={(e) => setOwner(e.target.value)} className={inputCls} autoComplete="new-password" /></label>
              <label className="block"><span className={labelCls}>Open password (optional)</span><input type="password" value={user} onChange={(e) => setUser(e.target.value)} className={inputCls} autoComplete="new-password" /></label>
              <div className="grid grid-cols-2 gap-1 text-xs">
                {(Object.keys(perm) as (keyof typeof perm)[]).map((k) => (
                  <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={perm[k]} onChange={(e) => setPerm({ ...perm, [k]: e.target.checked })} /> Allow {k === "fillingForms" ? "form filling" : k}</label>
                ))}
              </div>
              <p className="text-[11px] text-slate-500">Keep the owner password safe: it cannot be recovered. Permissions are enforced by compliant readers; some viewers ignore them.</p>
            </div>
          )}
          {props.redactionCount > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              {props.redactionCount} redaction mark(s) will be applied only by the secure option. The plain export draws them as black boxes over the page, and the underlying text remains in the file.
            </div>
          )}
          {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
          <p className="text-[11px] text-slate-500">Output file: {props.name}. Every export is checked by a parser before download. Document bookmarks and interactive form data are rebuilt when pages are reordered or resized (see Help → Limitations).</p>
        </section>
      </div>
    </Modal>
  );
}
