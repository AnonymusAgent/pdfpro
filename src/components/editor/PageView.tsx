"use client";

/**
 * One PDF page in the editor: lazy canvas rendering, selectable text layer, and an annotation
 * overlay. The overlay lives in page space and is rotated as a whole with the page, so every
 * annotation stays on the content it was placed on.
 */
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { boxFromPoints, clamp, displaySize, normRot, toPage, type Rot } from "@/lib/pdf/geometry";
import { itemAt, loadPdfJs, pageSize, renderPage, type PageText } from "@/lib/pdf/pdfjs";
import { uid as newId, type Ann, type AnnType, type Box, type FontFamily, type PageEntry, type Pt } from "@/lib/pdf/types";
import { cn } from "@/components/ui";

export type ToolId =
  | "select"
  | "hand"
  | "edittext"
  | "text"
  | "image"
  | "signature"
  | "highlight"
  | "underline"
  | "strike"
  | "draw"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "note"
  | "stamp"
  | "whiteout"
  | "redact"
  | "link"
  | "field"
  | "crop";

export type ToolStyle = {
  color: string;
  highlightColor: string;
  fill: string | null;
  fontSize: number;
  font: FontFamily;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  opacity: number;
  strokeWidth: number;
  stampText: string;
};

/** Callbacks from the workspace. Edits go through the workspace so undo/redo and autosave apply. */
export type EditorCtl = {
  tool: ToolId;
  style: ToolStyle;
  selectedId: string | null;
  editingId: string | null;
  signature: string | null;
  scroller: { current: HTMLDivElement | null };
  setSelected: (id: string | null) => void;
  setEditing: (id: string | null) => void;
  create: (a: Ann, opts?: { edit?: boolean }) => void;
  live: (uid: string, anns: Ann[]) => void;
  endGesture: () => void;
  setCrop: (uid: string, box: Box | null) => void;
  requestImage: (uid: string, p: Pt) => void;
  setDims: (uid: string, W0: number, H0: number) => void;
  visible: (index: number, ratio: number) => void;
  getPageText: (entry: PageEntry) => Promise<PageText | null>;
  notify: (kind: "success" | "error" | "info", text: string) => void;
};

type Props = {
  entry: PageEntry;
  index: number;
  pdf: PDFDocumentProxy | null;
  anns: Ann[];
  zoom: number;
  hitBoxes: Box[];
  activeHitBoxes: Box[];
  ctl: EditorCtl;
};

type Gesture =
  | { kind: "move"; id: string; offset: Pt; base: Ann[] }
  | { kind: "resize"; id: string; base: Ann[] }
  | { kind: "box"; start: Pt }
  | { kind: "draw"; points: Pt[] }
  | { kind: "crop"; start: Pt }
  | { kind: "pan"; x: number; y: number; sx: number; sy: number };

const TEXT_TYPES = new Set<AnnType>(["text", "note", "replace", "stamp", "field"]);
const FONT_CSS: Record<FontFamily, string> = {
  helvetica: "Helvetica, Arial, sans-serif",
  times: "'Times New Roman', Times, serif",
  courier: "'Courier New', Courier, monospace",
};

function boxOf(points: Pt[]): Box {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(0.002, Math.max(...xs) - x), h: Math.max(0.002, Math.max(...ys) - y) };
}

function imageAspect(dataUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im.naturalWidth / Math.max(1, im.naturalHeight));
    im.onerror = () => resolve(1);
    im.src = dataUrl;
  });
}

export default function PageView({ entry, index, pdf, anns, zoom, hitBoxes, activeHitBoxes, ctl }: Props) {
  const tool = ctl.tool;
  const style = ctl.style;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const ctlRef = useRef(ctl);
  const gesture = useRef<Gesture | null>(null);
  const [visible, setVisible] = useState(false);
  const [dims, setDims] = useState<{ W0: number; H0: number; R: Rot } | null>(null);
  const [draft, setDraft] = useState<Ann | null>(null);

  useEffect(() => {
    ctlRef.current = ctl;
  });

  // Lazy rendering: pages are drawn when they approach the viewport and released when far away.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        setVisible(e.isIntersecting);
        ctlRef.current.visible(index, e.intersectionRatio);
      },
      { root: ctlRef.current.scroller.current, rootMargin: "900px 0px", threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [index]);

  useEffect(() => {
    if (entry.src !== "blank") return;
    ctlRef.current.setDims(entry.uid, entry.blankW ?? 595.28, entry.blankH ?? 841.89);
  }, [entry.src, entry.blankW, entry.blankH, entry.uid]);

  useEffect(() => {
    if (entry.src === "blank" || !pdf) return;
    if (!visible) {
      const c = canvasRef.current;
      if (c) {
        c.width = 0;
        c.height = 0;
      }
      return;
    }
    let cancelled = false;
    let task: RenderTask | null = null;
    (async () => {
      const page = await pdf.getPage(entry.index + 1);
      if (cancelled) return;
      const size = pageSize(page);
      const R = normRot(size.rotate + entry.rot);
      setDims({ W0: size.W, H0: size.H, R });
      ctlRef.current.setDims(entry.uid, size.W, size.H);
      const canvas = canvasRef.current;
      if (!canvas) return;
      task = renderPage(page, canvas, { scale: zoom, rotation: R, dpr: Math.min(2, window.devicePixelRatio || 1) });
      await task.promise.catch(() => undefined);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, pdf, entry.index, entry.src, entry.rot, entry.uid, zoom]);

  // Text layer (native selection and copy) only while the Select tool is active.
  useEffect(() => {
    const host = textRef.current;
    if (!host) return;
    if (!visible || !pdf || entry.src === "blank" || tool !== "select") {
      host.innerHTML = "";
      return;
    }
    let cancelled = false;
    let layer: { cancel?: () => void } | null = null;
    (async () => {
      const pdfjs = await loadPdfJs();
      const page = await pdf.getPage(entry.index + 1);
      if (cancelled) return;
      const R = normRot(page.rotate + entry.rot);
      const viewport = page.getViewport({ scale: zoom, rotation: R });
      host.innerHTML = "";
      host.style.setProperty("--scale-factor", String(zoom));
      const tl = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: host, viewport });
      layer = tl;
      await tl.render();
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      layer?.cancel?.();
    };
  }, [visible, pdf, entry.index, entry.src, entry.rot, zoom, tool]);

  const isBlank = entry.src === "blank";
  const R: Rot = isBlank ? normRot(entry.rot) : (dims?.R ?? 0);
  const W0 = isBlank ? (entry.blankW ?? 595.28) : (dims?.W0 ?? 612);
  const H0 = isBlank ? (entry.blankH ?? 841.89) : (dims?.H0 ?? 792);
  const ready = isBlank || dims !== null;
  const disp = displaySize(W0, H0, R);
  const dispW = disp.w * zoom;
  const dispH = disp.h * zoom;
  const layerW = W0 * zoom;
  const layerH = H0 * zoom;

  const pagePoint = (e: { clientX: number; clientY: number }): Pt => {
    const r = overlayRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return { x: 0, y: 0 };
    return toPage({ x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) }, R);
  };

  const makeAnn = (type: AnnType, b: Box, extra: Partial<Ann> = {}): Ann => ({
    id: newId(),
    uid: entry.uid,
    type,
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    color: type === "highlight" ? style.highlightColor : style.color,
    fill: type === "rect" || type === "ellipse" ? style.fill : type === "whiteout" ? "#ffffff" : type === "note" ? "#fef08a" : null,
    opacity: type === "highlight" ? 0.4 : style.opacity,
    fontSize: style.fontSize,
    font: style.font,
    bold: style.bold,
    italic: style.italic,
    align: style.align,
    strokeWidth: style.strokeWidth,
    text: "",
    ...extra,
  });

  const defaultBox = (t: ToolId, p: Pt): Box => {
    const w = t === "stamp" ? 0.22 : 0.26;
    const h = t === "stamp" ? 0.06 : t === "note" ? 0.1 : 0.06;
    return { x: clamp(p.x, 0, 1 - w), y: clamp(p.y, 0, 1 - h), w, h };
  };

  const placeSignature = async (c: EditorCtl, p: Pt) => {
    if (!c.signature) {
      c.notify("info", "Create or upload a signature on the Sign & Secure page first, then place it here.");
      return;
    }
    const aspect = await imageAspect(c.signature);
    const w = 0.26;
    const h = (w * W0) / (aspect * H0);
    c.create(
      makeAnn("signature", { x: clamp(p.x, 0, 1 - w), y: clamp(p.y, 0, 1 - h), w, h }, { dataUrl: c.signature, aspect, opacity: 1, fill: null }),
    );
  };

  const finishBox = (c: EditorCtl, t: ToolId, start: Pt, end: Pt) => {
    const b = boxFromPoints(start, end);
    const tiny = b.w < 0.008 && b.h < 0.008;
    switch (t) {
      case "highlight":
      case "underline":
      case "strike":
      case "redact":
      case "whiteout":
      case "rect":
      case "ellipse":
        if (!tiny) c.create(makeAnn(t, b));
        return;
      case "line":
      case "arrow":
        if (Math.hypot(end.x - start.x, end.y - start.y) >= 0.01) c.create(makeAnn(t, b, { points: [start, end] }));
        return;
      case "text":
        c.create(makeAnn("text", tiny ? defaultBox(t, start) : b, { text: "New text" }), { edit: true });
        return;
      case "note":
        c.create(makeAnn("note", tiny ? defaultBox(t, start) : b, { text: "Comment" }), { edit: true });
        return;
      case "field":
        c.create(makeAnn("field", tiny ? defaultBox(t, start) : b, { text: "Field" }), { edit: true });
        return;
      case "link":
        c.create(makeAnn("link", tiny ? defaultBox(t, start) : b, { text: "Link", url: "" }), { edit: true });
        return;
      case "stamp":
        c.create(makeAnn("stamp", tiny ? defaultBox(t, start) : b, { text: style.stampText }));
        return;
      case "image":
        if (tiny) c.requestImage(entry.uid, start);
        return;
      case "signature":
        if (tiny) void placeSignature(c, start);
        return;
      case "crop":
        if (!tiny) c.setCrop(entry.uid, b);
        return;
      default:
        return;
    }
  };

  const handleEditText = async (p: Pt) => {
    const c = ctlRef.current;
    const pt = await c.getPageText(entry);
    if (!pt) {
      c.notify("info", "This page has no text layer. Run OCR first to make its text editable.");
      return;
    }
    const item = itemAt(pt, p);
    if (!item) {
      c.notify("info", "No text under the pointer. Click directly on a word.");
      return;
    }
    c.create(
      makeAnn("replace", { x: item.x, y: item.y, w: item.w, h: item.h }, {
        text: item.str,
        original: item.str,
        fontSize: Math.max(4, item.fontSize),
        font: "helvetica",
        color: "#111111",
        fill: "#ffffff",
        opacity: 1,
        bold: false,
        italic: false,
      }),
      { edit: true },
    );
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const c = ctlRef.current;
    if (!ready || e.button !== 0) return;
    if (c.tool === "select") {
      const id = (e.target as HTMLElement).closest("[data-ann]")?.getAttribute("data-ann");
      const ann = anns.find((item) => item.id === id);
      if (!ann) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      c.setSelected(ann.id);
      const p = pagePoint(e);
      gesture.current = (e.target as HTMLElement).closest("[data-handle]")
        ? { kind: "resize", id: ann.id, base: anns }
        : { kind: "move", id: ann.id, offset: { x: p.x - ann.x, y: p.y - ann.y }, base: anns };
      return;
    }
    const p = pagePoint(e);
    overlayRef.current?.setPointerCapture(e.pointerId);
    switch (c.tool) {
      case "hand":
        gesture.current = { kind: "pan", x: e.clientX, y: e.clientY, sx: c.scroller.current?.scrollLeft ?? 0, sy: c.scroller.current?.scrollTop ?? 0 };
        return;
      case "edittext":
        void handleEditText(p);
        return;
      case "draw":
        gesture.current = { kind: "draw", points: [p] };
        return;
      case "crop":
        gesture.current = { kind: "crop", start: p };
        return;
      default:
        gesture.current = { kind: "box", start: p };
    }
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || !ready) return;
    const c = ctlRef.current;
    if (g.kind === "pan") {
      const s = c.scroller.current;
      if (s) {
        s.scrollLeft = g.sx - (e.clientX - g.x);
        s.scrollTop = g.sy - (e.clientY - g.y);
      }
      return;
    }
    const p = pagePoint(e);
    if (g.kind === "move") {
      const nx = clamp(p.x - g.offset.x, -0.5, 1);
      const ny = clamp(p.y - g.offset.y, -0.5, 1);
      c.live(entry.uid, g.base.map((a) => (a.id === g.id ? { ...a, x: nx, y: ny } : a)));
      return;
    }
    if (g.kind === "resize") {
      const a = g.base.find((x) => x.id === g.id);
      if (!a) return;
      const w = Math.max(0.01, p.x - a.x);
      let h = Math.max(0.01, p.y - a.y);
      if (a.type === "image" || a.type === "signature") {
        const aspect = a.aspect ?? (a.w * W0) / (a.h * H0);
        h = (w * W0) / (aspect * H0);
      }
      c.live(entry.uid, g.base.map((x) => (x.id === g.id ? { ...x, w, h } : x)));
      return;
    }
    if (g.kind === "box") {
      const b = boxFromPoints(g.start, p);
      if (c.tool === "line" || c.tool === "arrow") setDraft(makeAnn(c.tool as AnnType, b, { points: [g.start, p] }));
      else setDraft(makeAnn(c.tool as AnnType, b));
      return;
    }
    if (g.kind === "draw") {
      g.points.push(p);
      setDraft(makeAnn("draw", boxOf(g.points), { points: [...g.points] }));
      return;
    }
    if (g.kind === "crop") {
      setDraft(makeAnn("rect", boxFromPoints(g.start, p), { color: "#2563eb", fill: null }));
    }
  };

  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    setDraft(null);
    if (!g) return;
    const c = ctlRef.current;
    if (g.kind === "move" || g.kind === "resize") {
      c.endGesture();
      return;
    }
    if (g.kind === "pan") return;
    const p = pagePoint(e);
    if (g.kind === "draw") {
      const pts = [...g.points, p];
      if (pts.length >= 2) c.create(makeAnn("draw", boxOf(pts), { points: pts }));
      return;
    }
    if (g.kind === "crop") {
      const b = boxFromPoints(g.start, p);
      if (b.w > 0.01 && b.h > 0.01) c.setCrop(entry.uid, b);
      return;
    }
    if (g.kind === "box") finishBox(c, c.tool, g.start, p);
  };

  const renderAnn = (a: Ann, isDraft = false): ReactNode => {
    const selected = !isDraft && ctl.selectedId === a.id;
    const editing = !isDraft && ctl.editingId === a.id;
    const interactive = !isDraft && tool === "select";
    const fontPx = a.fontSize * zoom;
    const sw = Math.max(1, (a.strokeWidth ?? 1.5) * zoom);
    const family = FONT_CSS[a.font ?? "helvetica"];
    const isText = TEXT_TYPES.has(a.type);
    const textStyle: CSSProperties = {
      fontFamily: family,
      fontSize: fontPx,
      fontWeight: a.bold || a.type === "stamp" ? 700 : 400,
      fontStyle: a.italic ? "italic" : "normal",
      color: a.color,
      textAlign: a.align ?? "left",
      opacity: a.opacity,
      lineHeight: 1.2,
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
    };
    const boxStyle: CSSProperties = {
      left: `${a.x * 100}%`,
      top: `${a.y * 100}%`,
      width: `${a.w * 100}%`,
      height: `${a.h * 100}%`,
      transform: a.rotation ? `rotate(${a.rotation}deg)` : undefined,
      pointerEvents: interactive || editing ? "auto" : "none",
      cursor: interactive ? "move" : undefined,
    };
    let body: ReactNode = null;
    switch (a.type) {
      case "highlight":
        body = <div className="h-full w-full" style={{ background: a.color, opacity: a.opacity, mixBlendMode: "multiply" }} />;
        break;
      case "underline":
        body = <div className="absolute inset-x-0 bottom-0" style={{ height: sw, background: a.color, opacity: a.opacity }} />;
        break;
      case "strike":
        body = <div className="absolute inset-x-0" style={{ top: "50%", height: sw, background: a.color, opacity: a.opacity, transform: "translateY(-50%)" }} />;
        break;
      case "rect":
        body = <div className="h-full w-full" style={{ border: `${sw}px solid ${a.color}`, background: a.fill ?? "transparent", opacity: a.opacity, boxSizing: "border-box" }} />;
        break;
      case "ellipse":
        body = <div className="h-full w-full" style={{ border: `${sw}px solid ${a.color}`, background: a.fill ?? "transparent", borderRadius: "50%", opacity: a.opacity, boxSizing: "border-box" }} />;
        break;
      case "whiteout":
        body = <div className="h-full w-full bg-white" />;
        break;
      case "redact":
        body = <div className="h-full w-full bg-black/90 outline outline-1 outline-red-600" title="Redaction mark (applied only by Secure export)" />;
        break;
      case "image":
      case "signature":
        body = a.dataUrl ? <img src={a.dataUrl} alt="" draggable={false} className="h-full w-full select-none object-fill" style={{ opacity: a.opacity }} /> : null;
        break;
      case "link":
        body = (
          <div className="flex h-full w-full items-start justify-start border border-dashed border-blue-600 bg-blue-500/10 text-[10px] text-blue-800">
            <span className="px-1">{a.url ? a.url : "Set URL in Properties"}</span>
          </div>
        );
        break;
      case "line":
      case "arrow":
      case "draw":
        body = null;
        break;
      default: {
        const isNote = a.type === "note";
        const isField = a.type === "field";
        const isStamp = a.type === "stamp";
        const bg = isNote ? (a.fill ?? "#fef08a") : a.type === "replace" ? (a.fill ?? "#ffffff") : isField ? "#eef5ff" : (a.fill ?? "transparent");
        const content = isStamp ? (a.text ?? "").toUpperCase() : (a.text ?? "");
        body = (
          <div
            className="h-full w-full overflow-hidden"
            style={{
              ...textStyle,
              padding: 3 * zoom,
              boxSizing: "border-box",
              background: bg,
              border: isStamp ? `${2 * zoom}px solid ${a.color}` : isNote ? "1px solid #b8a03a" : isField ? "1px solid #2563eb" : undefined,
              display: isStamp ? "flex" : undefined,
              alignItems: isStamp ? "center" : undefined,
              justifyContent: isStamp ? "center" : undefined,
              visibility: editing ? "hidden" : undefined,
            }}
          >
            {content}
          </div>
        );
      }
    }
    return (
      <div
        key={isDraft ? "draft" : a.id}
        data-ann={isDraft ? undefined : a.id}
        data-type={a.type}
        className={cn("absolute", selected && "z-10 outline outline-2 outline-blue-600")}
        style={boxStyle}
      >
        {body}
        {editing && isText && (
          <textarea
            autoFocus
            value={a.text ?? ""}
            aria-label="Edit text"
            onChange={(e) => {
              const txt = e.target.value;
              ctl.live(entry.uid, anns.map((x) => (x.id === a.id ? { ...x, text: txt } : x)));
            }}
            onBlur={() => {
              ctl.endGesture();
              ctl.setEditing(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
              e.stopPropagation();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="absolute inset-0 h-full w-full resize-none border-0 bg-white/95 p-[3px] outline-none"
            style={{ ...textStyle, opacity: 1, padding: 3 * zoom, boxSizing: "border-box" }}
          />
        )}
        {selected && interactive && (
          <div
            data-handle
            aria-label="Resize"
            className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-white bg-blue-600"
          />
        )}
      </div>
    );
  };

  const cursor = tool === "select" ? "default" : tool === "hand" ? "grab" : tool === "text" || tool === "edittext" ? "text" : "crosshair";
  const crop = entry.crop;

  return (
    <div
      ref={wrapRef}
      id={`pg-${index}`}
      data-page-index={index}
      className="pdf-sheet relative mx-auto my-4 shrink-0 bg-white"
      style={{ width: dispW, height: dispH }}
      onPointerDown={(e) => {
        if (ctl.tool === "select" && !(e.target as HTMLElement).closest("[data-ann]")) ctl.setSelected(null);
      }}
    >
      <canvas ref={canvasRef} className="absolute left-0 top-0" aria-label={`Page ${index + 1}`} role="img" />
      <div ref={textRef} className="textLayer absolute inset-0 z-[2]" style={{ pointerEvents: tool === "select" ? "auto" : "none" }} />
      <div
        ref={overlayRef}
        className="absolute inset-0 z-[3]"
        style={{ pointerEvents: tool === "select" ? "none" : "auto", cursor }}
        onPointerDown={onDown}
        onDoubleClick={(e) => {
          if (ctlRef.current.tool !== "select") return;
          const id = (e.target as HTMLElement).closest("[data-ann]")?.getAttribute("data-ann");
          const ann = anns.find((item) => item.id === id);
          if (ann && TEXT_TYPES.has(ann.type)) ctlRef.current.setEditing(ann.id);
        }}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <div className="absolute" style={{ left: (dispW - layerW) / 2, top: (dispH - layerH) / 2, width: layerW, height: layerH, transform: `rotate(${R}deg)` }}>
          {hitBoxes.map((b, i) => (
            <div
              key={`hit-${i}`}
              className={cn("pointer-events-none absolute", activeHitBoxes.includes(b) ? "bg-orange-400/60" : "bg-yellow-300/50")}
              style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
            />
          ))}
          <svg className="pointer-events-none absolute inset-0" width={layerW} height={layerH} viewBox={`0 0 ${layerW} ${layerH}`}>
            {anns
              .filter((a) => a.type === "draw" && a.points && a.points.length > 1)
              .map((a) => (
                <polyline
                  key={a.id}
                  points={a.points!.map((p) => `${p.x * layerW},${p.y * layerH}`).join(" ")}
                  fill="none"
                  stroke={a.color}
                  strokeOpacity={a.opacity}
                  strokeWidth={Math.max(1, (a.strokeWidth ?? 1.5) * zoom)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            {anns
              .filter((a) => a.type === "line" || a.type === "arrow")
              .map((a) => {
                const [s, e] = a.points && a.points.length === 2 ? a.points : [{ x: a.x, y: a.y }, { x: a.x + a.w, y: a.y + a.h }];
                const sx = s.x * layerW;
                const sy = s.y * layerH;
                const ex = e.x * layerW;
                const ey = e.y * layerH;
                const ang = Math.atan2(ey - sy, ex - sx);
                const len = Math.max(8, 4 * (a.strokeWidth ?? 1.5)) * zoom;
                const sw = Math.max(1, (a.strokeWidth ?? 1.5) * zoom);
                const h1 = [ex + len * Math.cos(ang + 0.84 * Math.PI), ey + len * Math.sin(ang + 0.84 * Math.PI)];
                const h2 = [ex + len * Math.cos(ang - 0.84 * Math.PI), ey + len * Math.sin(ang - 0.84 * Math.PI)];
                return (
                  <g key={a.id} stroke={a.color} strokeOpacity={a.opacity} strokeWidth={sw} strokeLinecap="round">
                    <line x1={sx} y1={sy} x2={ex} y2={ey} />
                    {a.type === "arrow" && <polyline points={`${h1[0]},${h1[1]} ${ex},${ey} ${h2[0]},${h2[1]}`} fill="none" />}
                  </g>
                );
              })}
          </svg>
          {anns.map((a) => renderAnn(a))}
          {draft && renderAnn(draft, true)}
          {crop && (
            <>
              <div className="pointer-events-none absolute inset-x-0 top-0 bg-black/40" style={{ height: `${crop.y * 100}%` }} />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/40" style={{ height: `${(1 - crop.y - crop.h) * 100}%` }} />
              <div className="pointer-events-none absolute left-0 bg-black/40" style={{ top: `${crop.y * 100}%`, height: `${crop.h * 100}%`, width: `${crop.x * 100}%` }} />
              <div className="pointer-events-none absolute right-0 bg-black/40" style={{ top: `${crop.y * 100}%`, height: `${crop.h * 100}%`, width: `${(1 - crop.x - crop.w) * 100}%` }} />
              <div className="pointer-events-none absolute border-2 border-dashed border-blue-600" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }} />
            </>
          )}
        </div>
      </div>
      {!dims && entry.src !== "blank" && <div className="absolute inset-0 grid place-items-center text-xs text-slate-400">Loading page {index + 1}…</div>}
    </div>
  );
}
