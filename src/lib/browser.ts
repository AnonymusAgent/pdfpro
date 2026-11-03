/**
 * Browser utilities: local settings, downloads, printing, base64, IndexedDB session recovery,
 * API client and extension hand-off. Nothing here logs document content.
 */
import type { EditState } from "@/lib/pdf/types";
import { guestWorkspaceRequest } from "@/lib/browser-workspace";
export { formatBytes } from "@/lib/plans";

export type LocalSettings = {
  theme: "light" | "dark";
  defaultZoom: number;
  defaultView: "continuous" | "single" | "two-page";
  maxFileMB: number;
  autosave: boolean;
  ocrLang: string;
  extensionId: string;
};

export const DEFAULT_SETTINGS: LocalSettings = {
  theme: "light",
  defaultZoom: 100,
  defaultView: "continuous",
  maxFileMB: 100,
  autosave: true,
  ocrLang: "eng",
  extensionId: "",
};

const SETTINGS_KEY = "pdfpro-settings";

export function loadSettings(): LocalSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "{}") as Partial<LocalSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: LocalSettings) {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  window.dispatchEvent(new Event("pdfpro-local"));
}

export function applyTheme(theme: "light" | "dark") {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function maxUploadBytes(): number {
  return loadSettings().maxFileMB * 1024 * 1024;
}

export function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 180) || "document";
}

export function downloadBytes(data: Uint8Array | ArrayBuffer | Blob, filename: string, mime = "application/octet-stream") {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeFileName(filename);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Prints a PDF through a hidden frame (the browser's own PDF print pipeline). */
export function printPdfBytes(bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const frame = document.createElement("iframe");
  frame.style.display = "none";
  frame.src = url;
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } finally {
      setTimeout(() => {
        frame.remove();
        URL.revokeObjectURL(url);
      }, 60_000);
    }
  };
  document.body.appendChild(frame);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------ IndexedDB recovery */

const DB_NAME = "pdfpro";
const DB_VERSION = 1;

export type SessionMeta = {
  id: string;
  name: string;
  size: number;
  savedAt: number;
  edit: EditState;
  sources: { id: string; name: string }[];
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB is unavailable in this browser."));
  });
}

async function request<T>(store: "sessions" | "files", mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? req.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  } finally {
    db.close();
  }
}

export function putSessionMeta(meta: SessionMeta): Promise<IDBValidKey> {
  return request("sessions", "readwrite", (s) => s.put(meta));
}

export function putSessionFile(key: string, bytes: ArrayBuffer): Promise<IDBValidKey> {
  return request("files", "readwrite", (s) => s.put({ key, bytes }));
}

export async function getSessionFile(key: string): Promise<ArrayBuffer | undefined> {
  const rec = await request<{ key: string; bytes: ArrayBuffer } | undefined>("files", "readonly", (s) => s.get(key));
  return rec?.bytes;
}

export function listSessionMeta(): Promise<SessionMeta[]> {
  return request<SessionMeta[]>("sessions", "readonly", (s) => s.getAll()).then((rows) =>
    [...rows].sort((a, b) => b.savedAt - a.savedAt),
  );
}

/** Removes a session's metadata and every stored file for it (main file and extra sources). */
export async function deleteSession(id: string): Promise<void> {
  await request("sessions", "readwrite", (s) => s.delete(id));
  const keys = await request<IDBValidKey[]>("files", "readonly", (s) => s.getAllKeys());
  for (const k of keys) {
    const key = String(k);
    if (key === id || key.startsWith(`${id}:`)) await request("files", "readwrite", (s) => s.delete(key));
  }
}

/* ----------------------------------------------------------------- API */

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401) {
      const local = guestWorkspaceRequest<T>(url, init);
      if (local !== null) return local;
    }
    throw new ApiError(data.error || `Request failed (HTTP ${res.status})`, res.status);
  }
  return data as T;
}

/* --------------------------------------------------- extension hand-off */

type ChromeLike = {
  runtime?: {
    id?: string;
    lastError?: { message?: string };
    sendMessage: (extId: string, msg: unknown, cb: (resp: unknown) => void) => void;
  };
};

/** Asks the installed PDF Pro extension for a PDF it prepared (context menu / popup). */
export function takeExtensionHandoff(extensionId: string, handoffId: string): Promise<{ name: string; bytes: Uint8Array }> {
  const chromeApi = (globalThis as unknown as { chrome?: ChromeLike }).chrome;
  const rt = chromeApi?.runtime;
  if (!rt?.sendMessage) {
    return Promise.reject(new Error("The PDF Pro extension was not detected. Install it from the Extension page, or open the file here instead."));
  }
  return new Promise((resolve, reject) => {
    rt.sendMessage(extensionId, { type: "PDFPRO_TAKE_HANDOFF", id: handoffId }, (resp) => {
      if (rt.lastError) return reject(new Error(rt.lastError.message || "Extension message failed."));
      const r = resp as { ok?: boolean; error?: string; name?: string; base64?: string } | undefined;
      if (!r?.ok || !r.base64) return reject(new Error(r?.error || "The extension did not return a file."));
      resolve({ name: r.name || "document.pdf", bytes: base64ToBytes(r.base64) });
    });
  });
}
