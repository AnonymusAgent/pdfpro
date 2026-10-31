"use client";

/**
 * Workspace state: open documents (isolated per document), per-document undo/redo history,
 * dirty tracking, IndexedDB autosave and recovery, toasts, confirm dialogs and cross-page staging.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { openPdf, PdfOpenError, releasePdf } from "@/lib/pdf/pdfjs";
import { initialEdit, uid, type EditState, type SourceInfo } from "@/lib/pdf/types";
import {
  apiJson,
  deleteSession,
  getSessionFile,
  listSessionMeta,
  loadSettings,
  maxUploadBytes,
  putSessionFile,
  putSessionMeta,
  formatBytes,
  type SessionMeta,
} from "@/lib/browser";

export type DocRecord = {
  id: string;
  name: string;
  size: number;
  pageCount: number;
  /** Original bytes, never mutated. Edits live in `edit` and are applied at export time. */
  bytes: ArrayBuffer;
  /** Extra sources (other PDFs whose pages were inserted or used as replacements). */
  sources: SourceInfo[];
  /** pdf.js handles keyed by source id ("main" for the opened file). */
  pdfs: Record<string, PDFDocumentProxy>;
  edit: EditState;
  past: EditState[];
  future: EditState[];
  dirty: boolean;
  savedAt: number | null;
  openedAt: number;
};

export type ToastItem = { id: string; kind: "success" | "error" | "info"; text: string };
export type ConfirmOptions = { title: string; message: string; confirmLabel?: string; danger?: boolean };

type State = {
  docs: DocRecord[];
  activeId: string | null;
  toasts: ToastItem[];
  staged: File[];
  confirm: ConfirmOptions | null;
};

type Action =
  | { type: "open"; doc: DocRecord }
  | { type: "close"; id: string }
  | { type: "activate"; id: string }
  | { type: "commit"; id: string; edit: EditState; from?: EditState }
  | { type: "live"; id: string; edit: EditState }
  | { type: "undo" | "redo"; id: string }
  | { type: "saved"; id: string; at: number }
  | { type: "source"; id: string; source: SourceInfo; pdf: PDFDocumentProxy }
  | { type: "toast"; toast: ToastItem }
  | { type: "dismiss"; id: string }
  | { type: "stage"; files: File[] }
  | { type: "confirm"; opts: ConfirmOptions | null };

const MAX_HISTORY = 100;

function patch(state: State, id: string, fn: (d: DocRecord) => DocRecord): State {
  let changed = false;
  const docs = state.docs.map((d) => {
    if (d.id !== id) return d;
    const next = fn(d);
    if (next !== d) changed = true;
    return next;
  });
  return changed ? { ...state, docs } : state;
}

function reduce(state: State, a: Action): State {
  switch (a.type) {
    case "open":
      return { ...state, docs: [...state.docs.filter((d) => d.id !== a.doc.id), a.doc], activeId: a.doc.id };
    case "close": {
      const docs = state.docs.filter((d) => d.id !== a.id);
      const activeId = state.activeId === a.id ? (docs[docs.length - 1]?.id ?? null) : state.activeId;
      return { ...state, docs, activeId };
    }
    case "activate":
      return state.activeId === a.id ? state : { ...state, activeId: a.id };
    case "commit":
      return patch(state, a.id, (d) => {
        if (a.from === undefined && a.edit === d.edit) return d;
        return { ...d, edit: a.edit, past: [...d.past, a.from ?? d.edit].slice(-MAX_HISTORY), future: [], dirty: true };
      });
    case "live":
      return patch(state, a.id, (d) => (d.edit === a.edit ? d : { ...d, edit: a.edit, dirty: true }));
    case "undo":
      return patch(state, a.id, (d) => {
        if (!d.past.length) return d;
        const prev = d.past[d.past.length - 1];
        return { ...d, edit: prev, past: d.past.slice(0, -1), future: [d.edit, ...d.future].slice(0, MAX_HISTORY), dirty: true };
      });
    case "redo":
      return patch(state, a.id, (d) => {
        if (!d.future.length) return d;
        const [next, ...rest] = d.future;
        return { ...d, edit: next, past: [...d.past, d.edit].slice(-MAX_HISTORY), future: rest, dirty: true };
      });
    case "saved":
      return patch(state, a.id, (d) => ({ ...d, dirty: false, savedAt: a.at }));
    case "source":
      return patch(state, a.id, (d) => ({
        ...d,
        sources: [...d.sources.filter((s) => s.id !== a.source.id), a.source],
        pdfs: { ...d.pdfs, [a.source.id]: a.pdf },
      }));
    case "toast":
      return { ...state, toasts: [...state.toasts, a.toast].slice(-5) };
    case "dismiss":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== a.id) };
    case "stage":
      return { ...state, staged: a.files };
    case "confirm":
      return { ...state, confirm: a.opts };
  }
}

const initialState: State = { docs: [], activeId: null, toasts: [], staged: [], confirm: null };

export type OpenOpts = {
  id?: string;
  password?: string;
  edit?: EditState;
  sources?: SourceInfo[];
  savedAt?: number | null;
};

export type WorkspaceApi = {
  docs: DocRecord[];
  active: DocRecord | null;
  toasts: ToastItem[];
  confirmOpts: ConfirmOptions | null;
  recoverable: SessionMeta[];
  openFile: (file: File, password?: string) => Promise<string>;
  openBytes: (name: string, bytes: ArrayBuffer, opts?: OpenOpts) => Promise<string>;
  closeDocument: (id: string) => Promise<void>;
  activate: (id: string) => void;
  commit: (id: string, edit: EditState, from?: EditState) => void;
  live: (id: string, edit: EditState) => void;
  undo: (id: string) => void;
  redo: (id: string) => void;
  markSaved: (id: string) => void;
  addSource: (id: string, file: File) => Promise<SourceInfo>;
  notify: (kind: ToastItem["kind"], text: string) => void;
  dismissToast: (id: string) => void;
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  answerConfirm: (v: boolean) => void;
  stage: (files: File[]) => void;
  takeStaged: () => File[];
  restoreSession: (m: SessionMeta) => Promise<string>;
  discardSession: (id: string) => Promise<void>;
  refreshRecoverable: () => Promise<void>;
};

const WorkspaceContext = createContext<WorkspaceApi | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [recoverable, setRecoverable] = useState<SessionMeta[]>([]);
  const stateRef = useRef(state);
  const confirmResolver = useRef<((v: boolean) => void) | null>(null);
  const savedEdits = useRef<Record<string, EditState>>({});
  const filesSaved = useRef<Set<string>>(new Set());

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const notify = useCallback((kind: ToastItem["kind"], text: string) => {
    const id = uid();
    dispatch({ type: "toast", toast: { id, kind, text } });
    setTimeout(() => dispatch({ type: "dismiss", id }), kind === "error" ? 9000 : 4500);
  }, []);

  const dismissToast = useCallback((id: string) => dispatch({ type: "dismiss", id }), []);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        confirmResolver.current = resolve;
        dispatch({ type: "confirm", opts });
      }),
    [],
  );

  const answerConfirm = useCallback((v: boolean) => {
    confirmResolver.current?.(v);
    confirmResolver.current = null;
    dispatch({ type: "confirm", opts: null });
  }, []);

  const refreshRecoverable = useCallback(async () => {
    try {
      setRecoverable(await listSessionMeta());
    } catch {
      setRecoverable([]);
    }
  }, []);

  const openBytes = useCallback(
    async (name: string, bytes: ArrayBuffer, opts?: OpenOpts): Promise<string> => {
      const limit = maxUploadBytes();
      if (bytes.byteLength > limit) {
        throw new PdfOpenError(
          `This file is ${formatBytes(bytes.byteLength)}, above the ${loadSettings().maxFileMB} MB limit. Change the limit in Settings.`,
          "too-large",
        );
      }
      const pdf = await openPdf(bytes, opts?.password);
      const pdfs: Record<string, PDFDocumentProxy> = { main: pdf };
      const sources: SourceInfo[] = [];
      for (const s of opts?.sources ?? []) {
        try {
          pdfs[s.id] = await openPdf(s.bytes);
          sources.push(s);
        } catch (e) {
          notify("error", `Could not restore source "${s.name}": ${(e as Error).message}`);
        }
      }
      const id = opts?.id ?? uid();
      const edit = opts?.edit ?? initialEdit(pdf.numPages);
      dispatch({
        type: "open",
        doc: {
          id,
          name,
          size: bytes.byteLength,
          pageCount: pdf.numPages,
          bytes,
          sources,
          pdfs,
          edit,
          past: [],
          future: [],
          dirty: Boolean(opts?.edit),
          savedAt: opts?.savedAt ?? null,
          openedAt: Date.now(),
        },
      });
      return id;
    },
    [notify],
  );

  const openFile = useCallback(
    async (file: File, password?: string) => {
      if (file.size > maxUploadBytes()) {
        throw new PdfOpenError(`This file is ${formatBytes(file.size)}, above the ${loadSettings().maxFileMB} MB limit.`, "too-large");
      }
      const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
      if (!isPdf) {
        throw new PdfOpenError("Only PDF files open in the editor. Use Convert for Word, Excel, PowerPoint and image files.", "invalid");
      }
      const bytes = await file.arrayBuffer();
      const id = await openBytes(file.name, bytes, { password });
      const doc = stateRef.current.docs.find((d) => d.id === id);
      apiJson("/api/documents", {
        method: "POST",
        body: JSON.stringify({ name: file.name, size: file.size, pages: doc?.pageCount ?? 0, kind: "pdf" }),
      }).catch(() => undefined);
      return id;
    },
    [openBytes],
  );

  const closeDocument = useCallback(
    async (id: string) => {
      const d = stateRef.current.docs.find((x) => x.id === id);
      if (!d) return;
      if (d.dirty) {
        const ok = await confirm({
          title: "Close without saving?",
          message: `"${d.name}" has unsaved changes. Closing discards them and removes the autosaved recovery copy.`,
          confirmLabel: "Discard changes",
          danger: true,
        });
        if (!ok) return;
      }
      for (const p of Object.values(d.pdfs)) releasePdf(p);
      dispatch({ type: "close", id });
      filesSaved.current.delete(id);
      delete savedEdits.current[id];
      deleteSession(id).catch(() => undefined);
      void refreshRecoverable();
    },
    [confirm, refreshRecoverable],
  );

  const activate = useCallback((id: string) => dispatch({ type: "activate", id }), []);
  const commit = useCallback((id: string, edit: EditState, from?: EditState) => dispatch({ type: "commit", id, edit, from }), []);
  const live = useCallback((id: string, edit: EditState) => dispatch({ type: "live", id, edit }), []);
  const undo = useCallback((id: string) => dispatch({ type: "undo", id }), []);
  const redo = useCallback((id: string) => dispatch({ type: "redo", id }), []);

  const markSaved = useCallback(
    (id: string) => {
      dispatch({ type: "saved", id, at: Date.now() });
      // The exported file is now the user's copy; drop the recovery copy and re-store files if editing continues.
      filesSaved.current.delete(id);
      deleteSession(id).catch(() => undefined);
      void refreshRecoverable();
    },
    [refreshRecoverable],
  );

  const addSource = useCallback(async (id: string, file: File): Promise<SourceInfo> => {
    if (file.size > maxUploadBytes()) throw new PdfOpenError(`"${file.name}" is above the file size limit.`, "too-large");
    const bytes = await file.arrayBuffer();
    const pdf = await openPdf(bytes);
    const source: SourceInfo = { id: uid(), name: file.name, bytes };
    dispatch({ type: "source", id, source, pdf });
    return source;
  }, []);

  const stage = useCallback((files: File[]) => dispatch({ type: "stage", files }), []);
  const takeStaged = useCallback(() => {
    const files = stateRef.current.staged;
    dispatch({ type: "stage", files: [] });
    return files;
  }, []);

  const restoreSession = useCallback(
    async (m: SessionMeta) => {
      const bytes = await getSessionFile(m.id);
      if (!bytes) throw new Error("The recovery copy is incomplete and cannot be restored.");
      const sources: SourceInfo[] = [];
      for (const s of m.sources) {
        const b = await getSessionFile(`${m.id}:${s.id}`);
        if (b) sources.push({ id: s.id, name: s.name, bytes: b });
      }
      filesSaved.current.add(m.id);
      for (const s of sources) filesSaved.current.add(`${m.id}:${s.id}`);
      const id = await openBytes(m.name, bytes, { id: m.id, edit: m.edit, sources, savedAt: m.savedAt });
      setRecoverable((prev) => prev.filter((x) => x.id !== m.id));
      return id;
    },
    [openBytes],
  );

  const discardSession = useCallback(
    async (id: string) => {
      await deleteSession(id);
      filesSaved.current.delete(id);
      setRecoverable((prev) => prev.filter((x) => x.id !== id));
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    listSessionMeta()
      .then((m) => {
        if (alive) setRecoverable(m);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Autosave: only docs with unsaved changes; main/source bytes are written once per session.
  useEffect(() => {
    if (!loadSettings().autosave) return;
    const timer = setTimeout(() => {
      for (const d of state.docs) {
        if (!d.dirty || savedEdits.current[d.id] === d.edit) continue;
        const write = async () => {
          if (!filesSaved.current.has(d.id)) {
            await putSessionFile(d.id, d.bytes);
            filesSaved.current.add(d.id);
          }
          for (const s of d.sources) {
            const key = `${d.id}:${s.id}`;
            if (!filesSaved.current.has(key)) {
              await putSessionFile(key, s.bytes);
              filesSaved.current.add(key);
            }
          }
          await putSessionMeta({
            id: d.id,
            name: d.name,
            size: d.size,
            savedAt: Date.now(),
            edit: d.edit,
            sources: d.sources.map((s) => ({ id: s.id, name: s.name })),
          });
          savedEdits.current[d.id] = d.edit;
        };
        write().catch(() => notify("error", "Autosave failed. Your browser storage may be full — export your PDF to keep your changes."));
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [state.docs, notify]);

  // Warn before leaving the page with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (stateRef.current.docs.some((d) => d.dirty)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const active = useMemo(() => state.docs.find((d) => d.id === state.activeId) ?? null, [state.docs, state.activeId]);

  const api = useMemo<WorkspaceApi>(
    () => ({
      docs: state.docs,
      active,
      toasts: state.toasts,
      confirmOpts: state.confirm,
      recoverable,
      openFile,
      openBytes,
      closeDocument,
      activate,
      commit,
      live,
      undo,
      redo,
      markSaved,
      addSource,
      notify,
      dismissToast,
      confirm,
      answerConfirm,
      stage,
      takeStaged,
      restoreSession,
      discardSession,
      refreshRecoverable,
    }),
    [
      state.docs,
      state.toasts,
      state.confirm,
      active,
      recoverable,
      openFile,
      openBytes,
      closeDocument,
      activate,
      commit,
      live,
      undo,
      redo,
      markSaved,
      addSource,
      notify,
      dismissToast,
      confirm,
      answerConfirm,
      stage,
      takeStaged,
      restoreSession,
      discardSession,
      refreshRecoverable,
    ],
  );

  return <WorkspaceContext.Provider value={api}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceApi {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return ctx;
}
