"use client";

/**
 * Browser-only workspace history for visitors without an account. The server
 * never receives their signatures or document names; authenticated accounts
 * use the private database API instead. Existing server records are not moved.
 */
const PREFIX = "pdfpro-guest-workspace:";
const MAX_SIGNATURES = 20;

type Doc = { id: number; name: string; size: number; pages: number; kind: string; starred: boolean; createdAt: string; updatedAt: string };
type Job = { id: number; kind: string; fileName: string; status: string; inputSize: number; outputSize: number; message: string | null; createdAt: string };
type Signature = { id: number; name: string; kind: string; dataUrl: string; createdAt: string };

type Collection = "documents" | "jobs" | "signatures";

function read<T>(name: Collection): T[] {
  try {
    const value = JSON.parse(localStorage.getItem(PREFIX + name) ?? "[]");
    return Array.isArray(value) ? value as T[] : [];
  } catch { return []; }
}
function save<T>(name: Collection, rows: T[]) {
  localStorage.setItem(PREFIX + name, JSON.stringify(rows));
}
function nextId(rows: { id: number }[]): number {
  return Math.max(0, ...rows.map((row) => row.id)) + 1;
}

export function guestWorkspaceRequest<T>(url: string, init?: RequestInit): T | null {
  if (typeof window === "undefined") return null;
  const path = new URL(url, window.location.origin);
  const name = path.pathname.slice(5);
  if (!["documents", "jobs", "signatures", "settings"].includes(name) || path.pathname !== `/api/${name}`) return null;
  const method = (init?.method ?? "GET").toUpperCase();
  if (name === "settings") {
    if (method === "GET") return { settings: {} } as T;
    if (method === "PUT") return { ok: true } as T; // saveSettings already wrote browser preferences
    return null;
  }
  const collection = name as Collection;
  if (method === "GET") return { [collection]: read(collection) } as T;
  const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
  if (method === "POST" && collection === "documents") {
    const docs = read<Doc>("documents");
    const now = new Date().toISOString();
    const existing = docs.find((doc) => doc.name === body.name && doc.size === body.size);
    const doc: Doc = existing
      ? { ...existing, pages: Number(body.pages ?? existing.pages), updatedAt: now }
      : { id: nextId(docs), name: String(body.name ?? "document.pdf"), size: Number(body.size ?? 0), pages: Number(body.pages ?? 0), kind: String(body.kind ?? "pdf"), starred: false, createdAt: now, updatedAt: now };
    save("documents", [doc, ...docs.filter((item) => item.id !== doc.id)].slice(0, 100));
    return { document: doc } as T;
  }
  if (method === "PATCH" && collection === "documents") {
    const docs = read<Doc>("documents");
    const doc = docs.find((item) => item.id === Number(body.id));
    if (!doc) throw new Error("Document record not found.");
    const updated = { ...doc, ...(typeof body.starred === "boolean" ? { starred: body.starred } : {}), ...(typeof body.name === "string" ? { name: body.name } : {}), updatedAt: new Date().toISOString() };
    save("documents", docs.map((item) => item.id === doc.id ? updated : item));
    return { document: updated } as T;
  }
  if (method === "POST" && collection === "jobs") {
    const jobs = read<Job>("jobs");
    const job: Job = { id: nextId(jobs), kind: String(body.kind ?? "other"), fileName: String(body.fileName ?? "file"), status: String(body.status ?? "completed"), inputSize: Number(body.inputSize ?? 0), outputSize: Number(body.outputSize ?? 0), message: body.message ? String(body.message) : null, createdAt: new Date().toISOString() };
    save("jobs", [job, ...jobs].slice(0, 50));
    return { job } as T;
  }
  if (method === "POST" && collection === "signatures") {
    const signatures = read<Signature>("signatures");
    const signature: Signature = { id: nextId(signatures), name: String(body.name ?? "Signature"), kind: String(body.kind ?? "draw"), dataUrl: String(body.dataUrl ?? ""), createdAt: new Date().toISOString() };
    if (!/^data:image\/(png|jpeg);base64,/.test(signature.dataUrl) || signature.dataUrl.length > 700_000) throw new Error("Signature must be a PNG or JPEG under 700 KB.");
    if (signatures.length >= MAX_SIGNATURES) throw new Error("Delete an old signature before saving another in this browser.");
    save("signatures", [signature, ...signatures]);
    return { signature } as T;
  }
  if (method === "DELETE" && (collection === "documents" || collection === "signatures")) {
    const id = Number(path.searchParams.get("id"));
    const rows = read<Doc | Signature>(collection);
    if (!rows.some((item) => item.id === id)) throw new Error("Record not found.");
    save(collection, rows.filter((item) => item.id !== id));
    return { ok: true } as T;
  }
  return null;
}
