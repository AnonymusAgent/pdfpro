"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock, RefreshCw, Star, Trash2, RotateCcw, Activity } from "lucide-react";
import { useWorkspace } from "@/lib/store";
import { apiJson, formatBytes, type SessionMeta } from "@/lib/browser";
import { deleteSession } from "@/lib/browser";
import { Button, Card, Notice, PageTitle } from "@/components/ui";

type DocRow = { id: number; name: string; size: number; pages: number; starred: boolean; updatedAt: string };
type JobRow = { id: number; kind: string; fileName: string; status: string; inputSize: number; outputSize: number; message: string | null; createdAt: string };

export default function RecentPanel() {
  const { recoverable, restoreSession, discardSession, refreshRecoverable, notify, confirm } = useWorkspace();
  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, j] = await Promise.all([apiJson<{ documents: DocRow[] }>("/api/documents"), apiJson<{ jobs: JobRow[] }>("/api/jobs")]);
      setDocs(d.documents);
      setJobs(j.jobs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load history. Is the database running?");
      setDocs([]);
      setJobs([]);
    }
    void refreshRecoverable();
  }, [refreshRecoverable]);

  useEffect(() => {
    let alive = true;
    Promise.all([apiJson<{ documents: DocRow[] }>("/api/documents"), apiJson<{ jobs: JobRow[] }>("/api/jobs")])
      .then(([d, j]) => {
        if (!alive) return;
        setDocs(d.documents);
        setJobs(j.jobs);
      })
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message || "Could not load history. Is the database running?");
        setDocs([]);
        setJobs([]);
      });
    void refreshRecoverable();
    return () => {
      alive = false;
    };
  }, [refreshRecoverable]);

  const toggleStar = async (d: DocRow) => {
    await apiJson("/api/documents", { method: "PATCH", body: JSON.stringify({ id: d.id, starred: !d.starred }) }).catch((e: Error) => notify("error", e.message));
    void load();
  };

  const removeDoc = async (d: DocRow) => {
    const ok = await confirm({ title: "Remove from recent?", message: `“${d.name}” will be removed from the history list. Your file on disk is not affected.`, confirmLabel: "Remove", danger: true });
    if (!ok) return;
    await apiJson(`/api/documents?id=${d.id}`, { method: "DELETE" }).catch((e: Error) => notify("error", e.message));
    void load();
  };

  const clearRecovery = async () => {
    const ok = await confirm({ title: "Delete all recovery copies?", message: "Unsaved work that was autosaved in this browser will be permanently deleted.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    for (const m of recoverable as SessionMeta[]) await deleteSession(m.id).catch(() => undefined);
    void refreshRecoverable();
    notify("success", "Recovery copies deleted.");
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      <PageTitle
        title="Recent"
        description="Recently opened documents (name, size and page count only), recovery copies of unsaved work, and a processing log. No document content is stored here."
        actions={<Button onClick={() => void load()}><RefreshCw size={14} /> Refresh</Button>}
      />
      {error && <div className="mb-4"><Notice tone="warn">{error}. Documents and jobs need the PostgreSQL database; the editor and tools still work without it.</Notice></div>}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Documents" icon={<Clock size={18} aria-hidden />}>
          {docs === null && <p className="text-sm text-slate-500">Loading…</p>}
          {docs?.length === 0 && <p className="text-sm text-slate-500">Nothing yet. Open a PDF in the editor to add it here.</p>}
          <ul className="divide-y dark:divide-slate-700">
            {docs?.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{d.name}</p>
                  <p className="text-xs text-slate-500">{d.pages} pages · {formatBytes(d.size)} · {new Date(d.updatedAt).toLocaleString()}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button type="button" onClick={() => toggleStar(d)} aria-pressed={d.starred} aria-label={d.starred ? `Unstar ${d.name}` : `Star ${d.name}`} className="rounded p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800">
                    <Star size={16} className={d.starred ? "fill-amber-400 text-amber-400" : "text-slate-400"} />
                  </button>
                  <button type="button" onClick={() => removeDoc(d)} aria-label={`Remove ${d.name} from history`} className="rounded p-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950">
                    <Trash2 size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Recovery copies" icon={<RotateCcw size={18} aria-hidden />} actions={recoverable.length ? <Button size="sm" variant="danger" onClick={clearRecovery}>Delete all</Button> : undefined}>
          {recoverable.length === 0 && <p className="text-sm text-slate-500">No unsaved work is waiting for recovery. Autosave runs while you edit and keeps copies in this browser only.</p>}
          <ul className="divide-y dark:divide-slate-700">
            {recoverable.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{m.name}</p>
                  <p className="text-xs text-slate-500">Autosaved {new Date(m.savedAt).toLocaleString()} · {m.edit.anns.length} edit object(s)</p>
                </div>
                <span className="flex gap-2">
                  <Button size="sm" variant="primary" onClick={() => restoreSession(m).then(() => (window.location.href = "/editor")).catch((e: Error) => notify("error", e.message))}>Restore</Button>
                  <Button size="sm" onClick={() => discardSession(m.id)}>Discard</Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title="Processing log" icon={<Activity size={18} aria-hidden />} className="mt-6">
        {jobs === null && <p className="text-sm text-slate-500">Loading…</p>}
        {jobs?.length === 0 && <p className="text-sm text-slate-500">Conversions, OCR runs, merges and exports are logged here (no document content).</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr><th className="py-2 pr-3">When</th><th className="py-2 pr-3">Operation</th><th className="py-2 pr-3">File</th><th className="py-2 pr-3">Size</th><th className="py-2 pr-3">Status</th></tr>
            </thead>
            <tbody className="divide-y dark:divide-slate-700">
              {jobs?.map((j) => (
                <tr key={j.id}>
                  <td className="py-2 pr-3 text-xs text-slate-500">{new Date(j.createdAt).toLocaleString()}</td>
                  <td className="py-2 pr-3">{j.kind}</td>
                  <td className="max-w-[220px] truncate py-2 pr-3">{j.fileName}</td>
                  <td className="py-2 pr-3 text-xs">{formatBytes(j.inputSize)} → {formatBytes(j.outputSize)}</td>
                  <td className="py-2 pr-3"><span className={j.status === "completed" ? "text-emerald-600" : "text-red-600"}>{j.status}</span>{j.message ? <span className="block text-xs text-slate-500">{j.message}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
