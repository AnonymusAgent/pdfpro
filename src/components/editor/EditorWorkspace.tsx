"use client";

import "pdfjs-dist/web/pdf_viewer.css";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Calendar,
  Circle,
  Crop,
  Download,
  Eraser,
  EyeOff,
  FileText,
  Hand,
  Highlighter,
  ImagePlus,
  Link2,
  Minus,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Pencil,
  PencilLine,
  PenLine,
  Printer,
  Redo2,
  Rows3,
  Search,
  Square,
  Stamp,
  StickyNote,
  Strikethrough,
  Type,
  Underline,
  Undo2,
  ZoomIn,
  ZoomOut,
  X,
} from "lucide-react";
import { useWorkspace, type DocRecord } from "@/lib/store";
import { Button, Dropzone, EmptyState, Notice, PageTitle, Spinner, cn, inputCls } from "@/components/ui";
import { apiJson, baseName, downloadBytes, formatBytes, loadSettings, printPdfBytes, takeExtensionHandoff } from "@/lib/browser";
import { exportDocument, verifyRedaction } from "@/lib/pdf/document-export";
import { findInPage, getAttachments, getOutline, getPageText, openPdf, PdfOpenError, releasePdf, type OutlineNode, type PageText } from "@/lib/pdf/pdfjs";
import { createBlankPdf, createSamplePdf } from "@/lib/pdf/operations";
import { EXTENSIONS, MIME_TYPES, verifyOutput } from "@/lib/pdf/validate";
import { clamp } from "@/lib/pdf/geometry";
import { initialEdit, uid, type Ann, type Box, type EditState, type PageEntry, type Pt } from "@/lib/pdf/types";
import type { ExportOptions } from "@/lib/pdf/export";
import PageView, { type EditorCtl, type ToolId, type ToolStyle } from "./PageView";
import { ExportDialog, FilesPanel, NotesPanel, OutlinePanel, PagesPanel, PropertiesPanel } from "./EditorPanels";

const TOOLS: { id: ToolId; label: string; icon: LucideIcon; hint: string }[] = [
  { id: "select", label: "Select", icon: MousePointer2, hint: "Select, move and resize (V)" },
  { id: "hand", label: "Pan", icon: Hand, hint: "Drag to scroll the page (H)" },
  { id: "edittext", label: "Edit text", icon: PencilLine, hint: "Click existing text to replace it. The original text stays under a white cover; use Secure export to remove it (E)" },
  { id: "text", label: "Add text", icon: Type, hint: "Click or drag to add a text box (T)" },
  { id: "image", label: "Image", icon: ImagePlus, hint: "Insert a PNG or JPEG image" },
  { id: "signature", label: "Signature", icon: PenLine, hint: "Place the signature saved on the Sign & Secure page" },
  { id: "highlight", label: "Highlight", icon: Highlighter, hint: "Highlight an area" },
  { id: "underline", label: "Underline", icon: Underline, hint: "Underline an area" },
  { id: "strike", label: "Strike", icon: Strikethrough, hint: "Strike through an area" },
  { id: "draw", label: "Draw", icon: Pencil, hint: "Freehand drawing" },
  { id: "rect", label: "Rectangle", icon: Square, hint: "Draw a rectangle" },
  { id: "ellipse", label: "Ellipse", icon: Circle, hint: "Draw an ellipse" },
  { id: "line", label: "Line", icon: Minus, hint: "Draw a line" },
  { id: "arrow", label: "Arrow", icon: ArrowRight, hint: "Draw an arrow" },
  { id: "note", label: "Note", icon: StickyNote, hint: "Add a sticky-note comment" },
  { id: "stamp", label: "Stamp", icon: Stamp, hint: "Add a stamp" },
  { id: "whiteout", label: "Whiteout", icon: Eraser, hint: "Cover an area with white (visual only, not a redaction)" },
  { id: "redact", label: "Redact", icon: EyeOff, hint: "Mark an area to redact. Only Secure export removes the content" },
  { id: "link", label: "Link", icon: Link2, hint: "Add a clickable link (set the address in Properties)" },
  { id: "field", label: "Form field", icon: Rows3, hint: "Add a fillable text field" },
  { id: "crop", label: "Crop", icon: Crop, hint: "Drag to set the crop box of the current page" },
];

const STAMPS = ["APPROVED", "DRAFT", "REVIEWED", "CONFIDENTIAL", "PAID", "URGENT", "FOR REVIEW"];
const SHORTCUTS: Record<string, ToolId> = { v: "select", h: "hand", e: "edittext", t: "text", r: "redact", c: "crop" };
const CHROME_ID = /^[a-p]{32}$/;

type SidebarTab = "pages" | "outline" | "notes" | "files";
type ViewMode = "continuous" | "single" | "two-page";
type Zoom = number | "width" | "page";

function sigFromStorage(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("pdfpro-signature");
}

function logJob(kind: string, fileName: string, inputSize: number, outputSize: number, message: string, status = "completed") {
  apiJson("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ kind, fileName, inputSize, outputSize, message, status }),
  }).catch(() => undefined);
}

/* ============================================================ workspace shell */

export default function EditorWorkspace() {
  const ws = useWorkspace();
  const { active, docs, recoverable, openBytes, openFile, restoreSession, discardSession, notify, closeDocument, activate } = ws;
  const params = useSearchParams();
  const router = useRouter();
  const handled = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pwPrompt, setPwPrompt] = useState<{ file: File; message: string } | null>(null);
  const [pw, setPw] = useState("");
  const [handoffBusy, setHandoffBusy] = useState(() => Boolean(params.get("handoff") && params.get("ext")));


  useEffect(() => {
    const h = params.get("handoff");
    const ext = params.get("ext");
    if (!h || !ext || handled.current) return;
    handled.current = true;
    if (!CHROME_ID.test(ext)) {
      notify("error", "The extension identifier in this link is invalid.");
      return;
    }
    takeExtensionHandoff(ext, h)
      .then(async (r) => {
        await openBytes(r.name, r.bytes.slice().buffer as ArrayBuffer);
        notify("success", `Opened ${r.name} from the PDF Pro extension.`);
        router.replace("/editor");
      })
      .catch((e: Error) => {
        notify("error", e.message);
        router.replace("/editor");
      })
      .finally(() => setHandoffBusy(false));
  }, [params, openBytes, router, notify]);

  const openSafe = async (file: File, password?: string) => {
    try {
      await openFile(file, password);
      setPwPrompt(null);
      setPw("");
    } catch (e) {
      if (e instanceof PdfOpenError && (e.code === "password-required" || e.code === "password-incorrect")) {
        setPwPrompt({ file, message: e.message });
        return;
      }
      notify("error", e instanceof Error ? e.message : "The file could not be opened.");
    }
  };

  const openSample = async () => {
    const bytes = await createSamplePdf();
    await openBytes("PDF-Pro-Sample.pdf", bytes.slice().buffer as ArrayBuffer);
    notify("success", "Sample document opened. Try annotating, reordering pages or exporting.");
  };

  const openBlank = async () => {
    const bytes = await createBlankPdf();
    await openBytes("Untitled.pdf", bytes.slice().buffer as ArrayBuffer);
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) void openSafe(f);
  };

  if (handoffBusy) {
    return (
      <div className="p-8">
        <Notice tone="info">
          <Spinner label="Receiving the file from the PDF Pro extension…" />
        </Notice>
      </div>
    );
  }

  const passwordModal = pwPrompt && (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/50 p-4" role="dialog" aria-modal="true" aria-label="Password required">
      <form
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900"
        onSubmit={(e) => {
          e.preventDefault();
          void openSafe(pwPrompt.file, pw);
        }}
      >
        <h2 className="font-bold">Password required</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{pwPrompt.message}</p>
        <p className="mt-2 text-xs text-slate-500">File: {pwPrompt.file.name}</p>
        <input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          className={cn(inputCls, "mt-3")}
          aria-label="PDF password"
          autoComplete="off"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setPwPrompt(null)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!pw}>Open</Button>
        </div>
      </form>
    </div>
  );

  if (!active) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
        <PageTitle title="Editor" description="Open a PDF to view, annotate, edit text and images, reorder or extract pages, redact, sign and export. Everything runs in your browser." />
        {recoverable.length > 0 && (
          <Notice tone="warn">
            <p className="font-semibold">Unsaved work was found in this browser.</p>
            <ul className="mt-2 space-y-2">
              {recoverable.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{m.name} · autosaved {new Date(m.savedAt).toLocaleString()}</span>
                  <span className="flex gap-2">
                    <Button size="sm" variant="primary" onClick={() => restoreSession(m).catch((e: Error) => notify("error", e.message))}>Restore</Button>
                    <Button size="sm" onClick={() => discardSession(m.id)}>Discard</Button>
                  </span>
                </li>
              ))}
            </ul>
          </Notice>
        )}
        <Dropzone
          accept=".pdf,application/pdf"
          title="Drop a PDF here, or click to choose one"
          hint="Processed locally. Files are limited to the size set in Settings (default 100 MB)."
          onFiles={(f) => void openSafe(f[0])}
        />
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={openSample}>Open sample document</Button>
          <Button variant="secondary" onClick={openBlank}>New blank PDF</Button>
        </div>
        <Notice>
          <b>Editing limits, stated plainly:</b> existing text can be replaced with an overlay (the original stays under a white cover). Only Secure export removes text. Scanned pages have no text layer until you run OCR.
        </Notice>
        <input ref={fileRef} type="file" accept=".pdf,application/pdf" className="hidden" onChange={onPick} aria-label="Choose PDF" />
        {passwordModal}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 overflow-x-auto border-b bg-slate-100 px-2 py-1 dark:border-slate-700 dark:bg-slate-950" role="tablist" aria-label="Open documents">
        {docs.map((d) => (
          <div key={d.id} role="tab" aria-selected={d.id === active.id} tabIndex={0} onClick={() => activate(d.id)} onKeyDown={(e) => e.key === "Enter" && activate(d.id)} className={cn("flex max-w-[220px] cursor-pointer items-center gap-2 rounded-t-lg px-3 py-1.5 text-xs", d.id === active.id ? "bg-white font-semibold shadow-sm dark:bg-slate-800" : "text-slate-600 hover:bg-white/60 dark:text-slate-400")}>
            <FileText size={12} aria-hidden />
            <span className="truncate">{d.name}</span>
            {d.dirty && <span className="text-amber-500" aria-label="unsaved changes">●</span>}
            <button type="button" aria-label={`Close ${d.name}`} onClick={(e) => { e.stopPropagation(); void closeDocument(d.id); }} className="rounded p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700">
              <X size={11} />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => fileRef.current?.click()} className="ml-1 whitespace-nowrap rounded-lg px-2 py-1 text-xs font-semibold text-blue-600 hover:bg-white/70 dark:hover:bg-slate-800">+ Open PDF</button>
        <input ref={fileRef} type="file" accept=".pdf,application/pdf" className="hidden" onChange={onPick} aria-label="Choose PDF" />
      </div>
      <EditorBody key={active.id} doc={active} openMore={() => fileRef.current?.click()} />
      {passwordModal}
    </div>
  );
}

/* ============================================================ editor body */

function EditorBody({ doc, openMore }: { doc: DocRecord; openMore: () => void }) {
  const { commit, live: liveStore, undo, redo, markSaved, addSource, notify, confirm } = useWorkspace();
  const settings = useMemo(() => loadSettings(), []);
  const editRef = useRef<EditState>(doc.edit);
  const gestureFrom = useRef<EditState | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const textCache = useRef(new Map<string, PageText>());
  const imageInput = useRef<HTMLInputElement>(null);
  const insertInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingImage = useRef<{ uid: string; p: Pt } | null>(null);
  const pendingReplace = useRef<number | null>(null);
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  const visibility = useRef<Record<number, number>>({});

  const [tool, setTool] = useState<ToolId>("select");
  const [style, setStyle] = useState<ToolStyle>({
    color: "#111827",
    highlightColor: "#facc15",
    fill: null,
    fontSize: 14,
    font: "helvetica",
    bold: false,
    italic: false,
    align: "left",
    opacity: 1,
    strokeWidth: 1.5,
    stampText: "APPROVED",
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [zoomMode, setZoomMode] = useState<Zoom>(settings.defaultZoom ? settings.defaultZoom / 100 : "width");
  const [viewMode, setViewMode] = useState<ViewMode>(settings.defaultView);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [propsOpen, setPropsOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("pages");
  const [dims, setDimsState] = useState<Record<string, { W0: number; H0: number }>>({});
  const [box, setBox] = useState({ w: 900, h: 700 });
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<{ index: number; uid: string; boxes: Box[] }[]>([]);
  const [hitIdx, setHitIdx] = useState(0);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);
  const [attachments, setAttachments] = useState<{ name: string; bytes: Uint8Array }[] | null>(null);

  const entries = doc.edit.pages;
  const curEntry = entries[clamp(page - 1, 0, Math.max(0, entries.length - 1))];
  const anns = doc.edit.anns;
  const selected = anns.find((a) => a.id === selectedId) ?? null;
  const redactionCount = anns.filter((a) => a.type === "redact").length;

  useEffect(() => {
    editRef.current = doc.edit;
  }, [doc.edit]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (sidebarTab === "outline" && outline === null) {
      const main = doc.pdfs.main;
      if (main) getOutline(main).then(setOutline).catch(() => setOutline([]));
    }
    if (sidebarTab === "files" && attachments === null) {
      const main = doc.pdfs.main;
      if (main) getAttachments(main).then(setAttachments).catch(() => setAttachments([]));
    }
  }, [sidebarTab, outline, attachments, doc.pdfs]);

  /* ---- edit plumbing: live (gesture) edits, commits, undo-able gestures ---- */

  const liveEdit = (next: EditState) => {
    if (!gestureFrom.current) gestureFrom.current = editRef.current;
    editRef.current = next;
    liveStore(doc.id, next);
  };
  const commitEdit = (next: EditState) => {
    gestureFrom.current = null;
    editRef.current = next;
    commit(doc.id, next);
  };
  const endGesture = () => {
    const from = gestureFrom.current;
    gestureFrom.current = null;
    if (from && from !== editRef.current) commit(doc.id, editRef.current, from);
  };

  const pageDims = (uid_: string) => dims[uid_];
  const curDims = curEntry ? pageDims(curEntry.uid) : undefined;

  const pageW = curDims ? curDims.W0 : 612;
  const pageH = curDims ? curDims.H0 : 792;
  const zoom: number = typeof zoomMode === "number" ? zoomMode : zoomMode === "width" ? clamp((box.w - 64) / pageW, 0.2, 4) : clamp(Math.min((box.w - 64) / pageW, (box.h - 64) / pageH), 0.2, 4);

  const ctl: EditorCtl = {
    tool,
    style,
    selectedId,
    editingId,
    signature: sigFromStorage(),
    scroller,
    setSelected: setSelectedId,
    setEditing: setEditingId,
    create: (a, o) => {
      const cur = editRef.current;
      commitEdit({ ...cur, anns: [...cur.anns, a] });
      setSelectedId(a.id);
      setEditingId(o?.edit ? a.id : null);
      if (tool !== "select" && !o?.edit && a.type !== "draw") setTool("select");
    },
    live: (u, list) => {
      const cur = editRef.current;
      liveEdit({ ...cur, anns: cur.anns.map((a) => list.find((x) => x.id === a.id) ?? a) });
    },
    endGesture,
    setCrop: (u, b) => {
      const cur = editRef.current;
      commitEdit({ ...cur, pages: cur.pages.map((p) => (p.uid === u ? { ...p, crop: b } : p)) });
      setTool("select");
    },
    requestImage: (u, p) => {
      pendingImage.current = { uid: u, p };
      imageInput.current?.click();
    },
    setDims: (u, W0, H0) =>
      setDimsState((prev) => (prev[u]?.W0 === W0 && prev[u]?.H0 === H0 ? prev : { ...prev, [u]: { W0, H0 } })),
    visible: (i, ratio) => {
      // The current page is the one most in view, not simply the last page reported.
      visibility.current[i] = ratio;
      if (viewMode !== "continuous") return;
      let best = -1;
      let bestRatio = 0;
      for (const [k, r] of Object.entries(visibility.current)) {
        if (r > bestRatio) {
          bestRatio = r;
          best = Number(k);
        }
      }
      if (best >= 0) setPage(best + 1);
    },
    getPageText: async (entry) => {
      if (entry.src === "blank") return null;
      const key = `${entry.src}:${entry.index}`;
      const cached = textCache.current.get(key);
      if (cached) return cached;
      const pdf = doc.pdfs[entry.src];
      if (!pdf) return null;
      const t = await getPageText(await pdf.getPage(entry.index + 1));
      textCache.current.set(key, t);
      return t;
    },
    notify,
  };

  const goTo = (n: number) => {
    const idx = clamp(n, 1, entries.length || 1);
    setPage(idx);
    if (viewMode === "continuous") document.getElementById(`pg-${idx - 1}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const patchSelected = (patch: Partial<Ann>, mode: "gesture" | "commit") => {
    if (!selected) return;
    const cur = editRef.current;
    const next = { ...cur, anns: cur.anns.map((a) => (a.id === selected.id ? { ...a, ...patch } : a)) };
    if (mode === "gesture") liveEdit(next);
    else commitEdit(next);
  };

  const deleteSelected = () => {
    if (!selected) return;
    const cur = editRef.current;
    commitEdit({ ...cur, anns: cur.anns.filter((a) => a.id !== selected.id) });
    setSelectedId(null);
  };

  const duplicateSelected = () => {
    if (!selected) return;
    const cur = editRef.current;
    const copy = { ...selected, id: uid(), x: Math.min(0.9, selected.x + 0.02), y: Math.min(0.9, selected.y + 0.02) };
    commitEdit({ ...cur, anns: [...cur.anns, copy] });
    setSelectedId(copy.id);
  };

  const moveLayer = (dir: "front" | "back") => {
    if (!selected) return;
    const cur = editRef.current;
    const others = cur.anns.filter((a) => a.id !== selected.id);
    commitEdit({ ...cur, anns: dir === "front" ? [...others, selected] : [selected, ...others] });
  };

  /* ---- page operations ---- */

  const rotatePage = (i: number) => {
    const cur = editRef.current;
    const uid_ = cur.pages[i]?.uid;
    if (!uid_) return;
    commitEdit({ ...cur, pages: cur.pages.map((p) => (p.uid === uid_ ? { ...p, rot: (p.rot + 90) % 360 } : p)) });
  };

  const duplicatePage = (i: number) => {
    const cur = editRef.current;
    const src = cur.pages[i];
    if (!src) return;
    const newUid = uid();
    const copies = cur.anns.filter((a) => a.uid === src.uid).map((a) => ({ ...a, id: uid(), uid: newUid }));
    const pages = [...cur.pages];
    pages.splice(i + 1, 0, { ...src, uid: newUid, crop: src.crop ? { ...src.crop } : null });
    commitEdit({ pages, anns: [...cur.anns, ...copies] });
    setPage(i + 2);
    notify("success", `Duplicated page ${i + 1}.`);
  };

  const deletePage = async (i: number) => {
    const cur = editRef.current;
    const target = cur.pages[i];
    if (!target) return;
    if (cur.pages.length <= 1) {
      notify("error", "A document must keep at least one page.");
      return;
    }
    const annCount = cur.anns.filter((a) => a.uid === target.uid).length;
    const ok = await confirm({
      title: `Delete page ${i + 1}?`,
      message: annCount ? `This page has ${annCount} annotation(s) that will be removed too. You can undo this with Ctrl/Cmd+Z.` : "You can undo this with Ctrl/Cmd+Z until you close the document.",
      confirmLabel: "Delete page",
      danger: true,
    });
    if (!ok) return;
    commitEdit({ pages: cur.pages.filter((_, k) => k !== i), anns: cur.anns.filter((a) => a.uid !== target.uid) });
    setPage(Math.max(1, Math.min(i + 1, cur.pages.length - 1)));
  };

  const movePage = (from: number, to: number) => {
    const cur = editRef.current;
    const pages = [...cur.pages];
    const [m] = pages.splice(from, 1);
    pages.splice(to, 0, m);
    commitEdit({ ...cur, pages });
    setPage(to + 1);
  };

  const insertBlank = () => {
    const cur = editRef.current;
    const ref = curDims ?? { W0: 595.28, H0: 841.89 };
    const entry: PageEntry = { uid: uid(), src: "blank", index: -1, rot: 0, crop: null, blankW: ref.W0, blankH: ref.H0 };
    const at = clamp(page, 0, cur.pages.length);
    const pages = [...cur.pages.slice(0, at), entry, ...cur.pages.slice(at)];
    commitEdit({ ...cur, pages });
    setPage(at + 1);
  };

  const insertFromFile = async (file: File, replaceAt: number | null) => {
    try {
      const src = await addSource(doc.id, file);
      const pdf = await openPdf(src.bytes);
      const n = pdf.numPages;
      releasePdf(pdf);
      const cur = editRef.current;
      if (replaceAt === null) {
        const at = clamp(page, 0, cur.pages.length);
        const added: PageEntry[] = Array.from({ length: n }, (_, k) => ({ uid: uid(), src: src.id, index: k, rot: 0, crop: null }));
        commitEdit({ ...cur, pages: [...cur.pages.slice(0, at), ...added, ...cur.pages.slice(at)] });
        notify("success", `Inserted ${n} page(s) from ${file.name}.`);
      } else {
        const input = window.prompt(`Which page of ${file.name} should replace page ${replaceAt + 1}? (1–${n})`, "1");
        const pn = Number(input);
        if (!Number.isInteger(pn) || pn < 1 || pn > n) {
          notify("error", `Enter a page number between 1 and ${n}.`);
          return;
        }
        commitEdit({
          ...cur,
          pages: cur.pages.map((p, k) => (k === replaceAt ? { ...p, src: src.id, index: pn - 1, crop: null } : p)),
        });
        notify("info", "Page replaced. Annotations on that page were kept; review them.");
      }
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "The file could not be inserted.");
    }
  };

  const extractPages = async (indexes: number[]) => {
    if (!indexes.length) return;
    const cur = editRef.current;
    const picked = indexes.map((i) => cur.pages[i]).filter(Boolean);
    const uids = new Set(picked.map((p) => p.uid));
    const subset: EditState = { pages: picked, anns: cur.anns.filter((a) => uids.has(a.uid)) };
    setBusy("Extracting pages…");
    try {
      const result = await exportDocument(doc, {}, { secure: false, edit: subset });
      const check = await verifyOutput("pdf", result.bytes);
      if (!check.ok) throw new Error(check.error);
      downloadBytes(result.bytes, `${baseName(doc.name)}-extracted.pdf`, MIME_TYPES.pdf);
      logJob("extract", doc.name, doc.size, result.bytes.length, `${picked.length} page(s)`);
      notify("success", `Extracted ${picked.length} page(s). Your document is unchanged.`);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Extraction failed.");
    } finally {
      setBusy(null);
    }
  };

  const insertDate = () => {
    const d = new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    const cur = editRef.current;
    const a: Ann = {
      id: uid(),
      uid: curEntry.uid,
      type: "text",
      x: 0.62,
      y: 0.05,
      w: 0.3,
      h: 0.05,
      text: d,
      color: style.color,
      fill: null,
      opacity: 1,
      fontSize: style.fontSize,
      font: style.font,
      bold: false,
      italic: false,
      align: "right",
    };
    commitEdit({ ...cur, anns: [...cur.anns, a] });
    setSelectedId(a.id);
  };

  /* ---- search ---- */

  const runSearch = async (q: string) => {
    setSearch(q);
    if (!q.trim()) {
      setHits([]);
      return;
    }
    setSearching(true);
    const list: { index: number; uid: string; boxes: Box[] }[] = [];
    try {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.src === "blank") continue;
        const t = await ctl.getPageText(e);
        if (!t) continue;
        for (const h of findInPage(t, q, i)) list.push({ index: i, uid: e.uid, boxes: h.boxes });
      }
    } finally {
      setSearching(false);
    }
    setHits(list);
    setHitIdx(0);
    if (list[0]) goTo(list[0].index + 1);
    else notify("info", `No matches for “${q}”. Scanned pages need OCR before they can be searched.`);
  };

  const stepHit = (dir: 1 | -1) => {
    if (!hits.length) return;
    const n = (hitIdx + dir + hits.length) % hits.length;
    setHitIdx(n);
    goTo(hits[n].index + 1);
  };

  /* ---- export ---- */

  const runExport = async (opts: ExportOptions, secure: boolean) => {
    setExportOpen(false);
    setBusy(secure ? "Applying secure redaction and exporting…" : "Building PDF…");
    try {
      const edit = editRef.current;
      const result = await exportDocument(doc, opts, { secure, edit });
      if (secure) {
        const v = await verifyRedaction(doc, edit, result.bytes);
        if (!v.ok) throw new Error(`Redaction check failed: text from redacted areas can still be extracted (${v.leaked.slice(0, 5).join(", ")}). The file was not downloaded.`);
      }
      const check = await verifyOutput("pdf", result.bytes);
      if (!check.ok) throw new Error(`The exported file failed validation: ${check.error}`);
      const suffix = secure ? "-redacted" : "-edited";
      downloadBytes(result.bytes, `${baseName(doc.name)}${suffix}.pdf`, MIME_TYPES.pdf);
      markSaved(doc.id);
      logJob(secure ? "redact" : "export-pdf", doc.name, doc.size, result.bytes.length, secure ? "Secure redaction applied; text removed from redacted pages" : "Annotations and edits embedded");
      notify("success", secure ? "Secure export complete. Redacted pages contain no extractable text." : `Exported ${check.detail}.`);
      result.warnings.forEach((w) => notify("info", w));
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  };

  const printNow = async () => {
    setBusy("Preparing print…");
    try {
      const result = await exportDocument(doc, {}, { secure: false, edit: editRef.current });
      printPdfBytes(result.bytes);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Printing failed.");
    } finally {
      setBusy(null);
    }
  };

  const downloadOriginal = () => downloadBytes(new Uint8Array(doc.bytes.slice(0)), doc.name, MIME_TYPES.pdf);

  const onImagePicked = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    const pending = pendingImage.current;
    pendingImage.current = null;
    if (!f || !pending) return;
    if (!/^image\/(png|jpeg)$/.test(f.type)) {
      notify("error", "Only PNG and JPEG images can be inserted.");
      return;
    }
    if (f.size > 8 * 1024 * 1024) {
      notify("error", "Images must be 8 MB or smaller.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const img = new Image();
      img.onload = () => {
        const aspect = img.naturalWidth / Math.max(1, img.naturalHeight);
        const d = pageDims(pending.uid) ?? { W0: 612, H0: 792 };
        const w = 0.3;
        const h = (w * d.W0) / (aspect * d.H0);
        const cur = editRef.current;
        const a: Ann = {
          id: uid(),
          uid: pending.uid,
          type: "image",
          x: clamp(pending.p.x, 0, 1 - w),
          y: clamp(pending.p.y, 0, 1 - h),
          w,
          h,
          color: "#000000",
          fill: null,
          opacity: 1,
          fontSize: 12,
          rotation: 0,
          dataUrl,
          aspect,
        };
        commitEdit({ ...cur, anns: [...cur.anns, a] });
        setSelectedId(a.id);
        setTool("select");
      };
      img.onerror = () => notify("error", "The image could not be decoded.");
      img.src = dataUrl;
    };
    reader.readAsDataURL(f);
  };

  /* ---- keyboard shortcuts ---- */

  useEffect(() => {
    keyHandler.current = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest?.("input, textarea, select, [contenteditable='true']");
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z" && !e.shiftKey) {
        if (typing) return;
        e.preventDefault();
        undo(doc.id);
        return;
      }
      if (mod && ((k === "z" && e.shiftKey) || k === "y")) {
        if (typing) return;
        e.preventDefault();
        redo(doc.id);
        return;
      }
      if (mod && k === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (mod && k === "s") {
        e.preventDefault();
        setExportOpen(true);
        return;
      }
      if (mod && k === "p") {
        e.preventDefault();
        void printNow();
        return;
      }
      if (typing || mod || e.altKey) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if (e.key === "Escape") {
        setSelectedId(null);
        setEditingId(null);
        setTool("select");
        return;
      }
      if (e.key === "ArrowRight" || e.key === "PageDown") goTo(page + 1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") goTo(page - 1);
      else if (e.key === "+" || e.key === "=") setZoomMode((z) => clamp((typeof z === "number" ? z : zoom) + 0.1, 0.2, 4));
      else if (e.key === "-") setZoomMode((z) => clamp((typeof z === "number" ? z : zoom) - 0.1, 0.2, 4));
      else if (e.key === "0") setZoomMode("width");
      else if (SHORTCUTS[k]) setTool(SHORTCUTS[k]);
    };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---- render ---- */

  const visibleIdx =
    viewMode === "single"
      ? [page - 1]
      : viewMode === "two-page"
        ? [Math.floor((page - 1) / 2) * 2, Math.floor((page - 1) / 2) * 2 + 1].filter((i) => i < entries.length)
        : entries.map((_, i) => i);

  const pageInfo = curEntry
    ? {
        index: page - 1,
        total: entries.length,
        W0: curDims?.W0 ?? curEntry.blankW ?? 612,
        H0: curDims?.H0 ?? curEntry.blankH ?? 792,
        rot: curEntry.rot,
        crop: curEntry.crop,
        uid: curEntry.uid,
      }
    : null;

  const hitBoxesFor = (uid_: string) => hits.filter((h) => h.uid === uid_).flatMap((h) => h.boxes);
  const activeBoxesFor = (uid_: string) => (hits[hitIdx]?.uid === uid_ ? hits[hitIdx].boxes : []);
  const annCount = anns.length;

  const selectTool = (id: ToolId) => setTool(id);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* top bar */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
        <div className="min-w-0 max-w-[240px]">
          <p className="truncate text-sm font-bold" title={doc.name}>{doc.name}</p>
          <p className="text-[11px] text-slate-500">
            {doc.pageCount} pages • {formatBytes(doc.size)} •{" "}
            <span className={doc.dirty ? "font-semibold text-amber-600" : "text-emerald-600"}>{doc.dirty ? "Unsaved changes (autosaved in this browser)" : "Saved"}</span>
          </p>
        </div>
        <IconBtn label="Undo (Ctrl/Cmd+Z)" disabled={!doc.past.length} onClick={() => undo(doc.id)} icon={Undo2} />
        <IconBtn label="Redo (Ctrl/Cmd+Shift+Z)" disabled={!doc.future.length} onClick={() => redo(doc.id)} icon={Redo2} />
        <div className="flex items-center gap-1 rounded-lg bg-slate-100 px-2 dark:bg-slate-800">
          <Search size={14} className="text-slate-400" aria-hidden />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (hits.length && search === (hits.length ? search : "")) stepHit(e.shiftKey ? -1 : 1);
                else void runSearch(search);
              }
            }}
            placeholder="Find (Ctrl/Cmd+F)"
            aria-label="Find text in document"
            className="w-36 bg-transparent py-1.5 text-sm outline-none"
          />
          {searching && <Spinner />}
          {hits.length > 0 && (
            <span className="whitespace-nowrap text-[11px] text-slate-600 dark:text-slate-300">
              {hitIdx + 1}/{hits.length}
              <button type="button" className="ml-1 text-blue-600" onClick={() => stepHit(-1)} aria-label="Previous result">↑</button>
              <button type="button" className="ml-1 text-blue-600" onClick={() => stepHit(1)} aria-label="Next result">↓</button>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <IconBtn label="Zoom out (-)" onClick={() => setZoomMode(clamp(zoom - 0.1, 0.2, 4))} icon={ZoomOut} />
          <select
            aria-label="Zoom level"
            value={typeof zoomMode === "number" ? String(Math.round(zoomMode * 100)) : zoomMode}
            onChange={(e) => {
              const v = e.target.value;
              setZoomMode(v === "width" || v === "page" ? v : Number(v) / 100);
            }}
            className="rounded-lg border bg-white px-2 py-1 text-xs dark:border-slate-600 dark:bg-slate-800"
          >
            <option value="width">Fit width</option>
            <option value="page">Fit page</option>
            {[50, 75, 100, 125, 150, 200, Math.round(zoom * 100)].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b).map((v) => (
              <option key={v} value={v}>{v}%</option>
            ))}
          </select>
          <IconBtn label="Zoom in (+)" onClick={() => setZoomMode(clamp(zoom + 0.1, 0.2, 4))} icon={ZoomIn} />
        </div>
        <select aria-label="View mode" value={viewMode} onChange={(e) => setViewMode(e.target.value as ViewMode)} className="rounded-lg border bg-white px-2 py-1 text-xs dark:border-slate-600 dark:bg-slate-800">
          <option value="continuous">Continuous</option>
          <option value="single">Single page</option>
          <option value="two-page">Two pages</option>
        </select>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => void printNow()} title="Print (Ctrl/Cmd+P)"><Printer size={14} /> Print</Button>
          <Button size="sm" variant="secondary" onClick={downloadOriginal}>Original</Button>
          <Button size="sm" variant="success" onClick={() => setExportOpen(true)} title="Export (Ctrl/Cmd+S)"><Download size={14} /> Export…</Button>
          <IconBtn label="Toggle page panel" onClick={() => setSidebarOpen((v) => !v)} icon={PanelLeft} />
          <IconBtn label="Toggle properties panel" onClick={() => setPropsOpen((v) => !v)} icon={PanelRight} />
          <button type="button" onClick={openMore} className="text-xs font-semibold text-blue-600 hover:underline">Open another PDF</button>
        </div>
      </div>

      {/* tool bar */}
      <div className="flex flex-wrap items-center gap-1 border-b bg-[#162f4d] px-2 py-1.5 text-white" role="toolbar" aria-label="Editing tools">
        {TOOLS.map((t) => {
          const I = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              title={t.hint}
              aria-label={t.label}
              aria-pressed={tool === t.id}
              onClick={() => selectTool(t.id)}
              className={cn("flex min-w-[46px] flex-col items-center rounded-md px-1.5 py-1 text-[10px] leading-tight", tool === t.id ? "bg-blue-600" : "hover:bg-white/10")}
            >
              <I size={16} aria-hidden />
              {t.label}
            </button>
          );
        })}
        <span className="mx-1 h-8 w-px bg-white/20" aria-hidden />
        <label className="flex items-center gap-1 text-[11px]">Colour<input type="color" value={style.color} onChange={(e) => setStyle({ ...style, color: e.target.value })} className="h-6 w-7 rounded bg-transparent" aria-label="Text and shape colour" /></label>
        <label className="flex items-center gap-1 text-[11px]">Highlight<input type="color" value={style.highlightColor} onChange={(e) => setStyle({ ...style, highlightColor: e.target.value })} className="h-6 w-7 rounded bg-transparent" aria-label="Highlight colour" /></label>
        <label className="flex items-center gap-1 text-[11px]">Fill<input type="color" value={style.fill ?? "#ffffff"} onChange={(e) => setStyle({ ...style, fill: e.target.value })} className="h-6 w-7 rounded bg-transparent" aria-label="Shape fill colour" /></label>
        <button type="button" className="rounded px-1.5 py-1 text-[10px] hover:bg-white/10" onClick={() => setStyle({ ...style, fill: null })}>No fill</button>
        <label className="flex items-center gap-1 text-[11px]">Size<input type="number" min={4} max={96} value={style.fontSize} onChange={(e) => setStyle({ ...style, fontSize: clamp(Number(e.target.value) || 12, 4, 96) })} className="w-14 rounded bg-white/10 px-1 py-0.5 text-xs" aria-label="Font size" /></label>
        <select aria-label="Font" value={style.font} onChange={(e) => setStyle({ ...style, font: e.target.value as ToolStyle["font"] })} className="rounded bg-white/10 px-1 py-1 text-xs">
          <option value="helvetica" className="text-black">Sans</option>
          <option value="times" className="text-black">Serif</option>
          <option value="courier" className="text-black">Mono</option>
        </select>
        <button type="button" aria-pressed={style.bold} onClick={() => setStyle({ ...style, bold: !style.bold })} className={cn("rounded px-2 py-1 text-xs font-bold", style.bold ? "bg-blue-600" : "bg-white/10")}>B</button>
        <button type="button" aria-pressed={style.italic} onClick={() => setStyle({ ...style, italic: !style.italic })} className={cn("rounded px-2 py-1 text-xs italic", style.italic ? "bg-blue-600" : "bg-white/10")}>I</button>
        <select aria-label="Text alignment" value={style.align} onChange={(e) => setStyle({ ...style, align: e.target.value as ToolStyle["align"] })} className="rounded bg-white/10 px-1 py-1 text-xs">
          <option value="left" className="text-black">Left</option>
          <option value="center" className="text-black">Centre</option>
          <option value="right" className="text-black">Right</option>
        </select>
        <label className="flex items-center gap-1 text-[11px]">Opacity<input type="range" min={5} max={100} value={Math.round(style.opacity * 100)} onChange={(e) => setStyle({ ...style, opacity: Number(e.target.value) / 100 })} className="w-16" aria-label="Opacity" /></label>
        <label className="flex items-center gap-1 text-[11px]">Line<input type="number" min={0.5} max={12} step={0.5} value={style.strokeWidth} onChange={(e) => setStyle({ ...style, strokeWidth: clamp(Number(e.target.value) || 1, 0.5, 12) })} className="w-12 rounded bg-white/10 px-1 py-0.5 text-xs" aria-label="Line width" /></label>
        <select aria-label="Stamp type" value={style.stampText} onChange={(e) => setStyle({ ...style, stampText: e.target.value })} className="rounded bg-white/10 px-1 py-1 text-xs">
          {STAMPS.map((s) => <option key={s} value={s} className="text-black">{s}</option>)}
        </select>
        <button type="button" onClick={insertDate} className="flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-[11px] hover:bg-white/20"><Calendar size={13} aria-hidden /> Date</button>
      </div>

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <aside className="flex w-[220px] shrink-0 flex-col border-r bg-white dark:border-slate-700 dark:bg-slate-900" aria-label="Document panels">
            <div className="grid grid-cols-4 border-b text-[11px] font-semibold dark:border-slate-700" role="tablist">
              {(["pages", "outline", "notes", "files"] as SidebarTab[]).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={sidebarTab === t} onClick={() => setSidebarTab(t)} className={cn("py-2 capitalize", sidebarTab === t ? "border-b-2 border-blue-600 text-blue-600" : "text-slate-500")}>
                  {t === "notes" ? "Notes" : t === "files" ? "Files" : t}
                </button>
              ))}
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {sidebarTab === "pages" && (
                <PagesPanel
                  docId={doc.id}
                  entries={entries}
                  pdfs={doc.pdfs}
                  current={page - 1}
                  onGo={(i) => goTo(i + 1)}
                  onRotate={rotatePage}
                  onDuplicate={duplicatePage}
                  onDelete={(i) => void deletePage(i)}
                  onMove={movePage}
                  onInsertBlank={insertBlank}
                  onInsertFile={() => insertInput.current?.click()}
                  onReplaceFile={() => {
                    pendingReplace.current = page - 1;
                    replaceInput.current?.click();
                  }}
                  onExtract={(idx) => void extractPages(idx)}
                />
              )}
              {sidebarTab === "outline" && (
                <OutlinePanel
                  outline={outline}
                  onGo={(srcPage) => {
                    const i = entries.findIndex((e) => e.src === "main" && e.index === srcPage);
                    if (i >= 0) goTo(i + 1);
                    else notify("info", "That bookmark points to a page that is not in the current page order.");
                  }}
                />
              )}
              {sidebarTab === "notes" && (
                <NotesPanel
                  anns={anns}
                  entries={entries}
                  onSelect={(a, pi) => {
                    setSelectedId(a.id);
                    if (pi >= 0) goTo(pi + 1);
                  }}
                />
              )}
              {sidebarTab === "files" && (
                <FilesPanel
                  name={doc.name}
                  size={doc.size}
                  pageCount={doc.pageCount}
                  annCount={annCount}
                  attachments={attachments}
                  onDownload={(a) => downloadBytes(a.bytes, a.name)}
                />
              )}
            </div>
          </aside>
        )}

        <section ref={scroller} className="relative min-w-0 flex-1 overflow-auto bg-[#dfe6ef] p-4 dark:bg-slate-800" aria-label="Document pages">
          {busy && (
            <div className="sticky top-0 z-30 mb-3 flex justify-center">
              <div className="rounded-full bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white shadow"><Spinner label={busy} /></div>
            </div>
          )}
          <div className={cn(viewMode === "two-page" ? "flex flex-wrap items-start justify-center gap-6" : "flex flex-col items-center")}>
            {visibleIdx.map((i) => {
              const e = entries[i];
              if (!e) return null;
              return (
                <PageView
                  key={e.uid}
                  entry={e}
                  index={i}
                  pdf={e.src === "blank" ? null : (doc.pdfs[e.src] ?? null)}
                  anns={anns.filter((a) => a.uid === e.uid)}
                  zoom={zoom}
                  hitBoxes={hitBoxesFor(e.uid)}
                  activeHitBoxes={activeBoxesFor(e.uid)}
                  ctl={ctl}
                />
              );
            })}
          </div>
          {entries.length === 0 && <EmptyState title="No pages" text="Insert a page or undo to restore pages." />}
        </section>

        {propsOpen && (
          <aside className="w-[280px] shrink-0 overflow-y-auto border-l bg-white p-4 dark:border-slate-700 dark:bg-slate-900" aria-label="Properties">
            <h2 className="mb-3 text-sm font-bold">Properties</h2>
            <PropertiesPanel
              ann={selected}
              page={pageInfo}
              onPatch={patchSelected}
              onEnd={endGesture}
              onDelete={deleteSelected}
              onDuplicate={duplicateSelected}
              onRotatePage={() => rotatePage(page - 1)}
              onClearCrop={() => ctl.setCrop(curEntry.uid, null)}
              onInsertDate={insertDate}
              onMoveLayer={moveLayer}
            />
            <div className="mt-6 space-y-2 border-t pt-4 text-[11px] text-slate-500 dark:border-slate-700">
              <p className="font-semibold text-slate-700 dark:text-slate-300">Text on this page</p>
              <PageTextPreview key={curEntry?.uid ?? "none"} entry={curEntry} ctl={ctl} />
            </div>
          </aside>
        )}
      </div>

      <input ref={imageInput} type="file" accept="image/png,image/jpeg" className="hidden" onChange={onImagePicked} aria-label="Choose image" />
      <input
        ref={insertInput}
        type="file"
        accept=".pdf,application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void insertFromFile(f, null);
        }}
        aria-label="Choose PDF to insert pages from"
      />
      <input
        ref={replaceInput}
        type="file"
        accept=".pdf,application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f && pendingReplace.current !== null) void insertFromFile(f, pendingReplace.current);
        }}
        aria-label="Choose PDF to take the replacement page from"
      />

      <footer className="flex flex-wrap items-center justify-between gap-2 bg-[#0c1d33] px-4 py-1.5 text-xs text-slate-300">
        <span>Page {page} / {entries.length} • {Math.round(zoom * 100)}% • {tool === "select" ? "Select" : TOOLS.find((t) => t.id === tool)?.label}</span>
        <span>{busy ?? (settings.autosave ? "Autosave on (this browser)" : "Autosave off")}</span>
        <span>{annCount} annotations • {formatBytes(doc.size)}</span>
      </footer>

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} name={`${baseName(doc.name)}-edited.pdf`} redactionCount={redactionCount} onRun={runExport} />
    </div>
  );
}

function PageTextPreview({ entry, ctl }: { entry: PageEntry | undefined; ctl: EditorCtl }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!entry) return;
    ctl.getPageText(entry).then((t) => {
      if (alive) setText(t ? t.text : "");
    });
    return () => {
      alive = false;
    };
    // The page identity is what matters; ctl is recreated each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.uid, entry?.src, entry?.index]);
  if (!entry || entry.src === "blank") return <p>Blank page.</p>;
  if (text === null) return <p>Reading text…</p>;
  if (!text.trim()) {
    return (
      <p>
        No text layer on this page — it looks scanned. Use the <a className="font-semibold text-blue-600" href="/ocr">OCR workspace</a> to make it searchable and editable.
      </p>
    );
  }
  return <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-slate-600 dark:text-slate-300">{text.slice(0, 900)}</p>;
}

function IconBtn({ label, icon: Icon, onClick, disabled }: { label: string; icon: LucideIcon; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className="rounded-lg p-1.5 text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-200 dark:hover:bg-slate-800">
      <Icon size={16} aria-hidden />
    </button>
  );
}
