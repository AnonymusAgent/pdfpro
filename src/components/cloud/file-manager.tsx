"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Download,
  Eye,
  FileText,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { AdSlot } from "@/components/ads/ad-slot";
import { useSession } from "@/components/auth/session-provider";
import { Button, Card, Dropzone, EmptyState, Modal, Notice, ProgressBar, inputCls, labelCls } from "@/components/ui";
import { formatBytes } from "@/lib/plans";
import type { CloudFileDTO, StorageSnapshotDTO } from "@/lib/session-types";

type SortKey = "created" | "name" | "size";

export function CloudFileManager({
  initialStorage,
  premiumQuotaLabel = "Premium",
}: {
  initialStorage: StorageSnapshotDTO | null;
  /** Premium quota label, supplied by the server (never hardcoded here). */
  premiumQuotaLabel?: string;
}) {
  const { session, premium, refresh } = useSession();
  const [files, setFiles] = useState<CloudFileDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [storage, setStorage] = useState<StorageSnapshotDTO | null>(initialStorage);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("created");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [preview, setPreview] = useState<{ file: CloudFileDTO; url: string } | null>(null);
  const [renaming, setRenaming] = useState<CloudFileDTO | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<CloudFileDTO | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) setLoading(true);
      try {
        const params = new URLSearchParams({ sort, order, limit: "100" });
        if (q.trim()) params.set("q", q.trim());
        const response = await fetch(`/api/files?${params.toString()}`, { cache: "no-store" });
        const data = (await response.json()) as {
          files?: CloudFileDTO[];
          total?: number;
          storage?: StorageSnapshotDTO;
          error?: string;
        };
        if (!response.ok) {
          setError(data.error ?? "Could not load your files.");
          return;
        }
        setFiles(data.files ?? []);
        setTotal(data.total ?? 0);
        setStorage(data.storage ?? null);
        setError(null);
      } catch {
        setError("Network error while loading your files.");
      } finally {
        setLoading(false);
      }
    },
    [q, sort, order],
  );

  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);

  const upload = useCallback(
    async (fileList: File[]) => {
      const file = fileList[0];
      if (!file) return;
      if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
        setError("Only PDF files can be uploaded to cloud storage.");
        return;
      }
      setError(null);
      setNotice(null);
      setUploading({ name: file.name, percent: 0 });

      // XHR is used so the storage indicator can show real upload progress.
      await new Promise<void>((resolve) => {
        const form = new FormData();
        form.append("file", file);
        form.append("name", file.name);
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/files");
        xhr.withCredentials = true;
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            setUploading({ name: file.name, percent: Math.round((event.loaded / event.total) * 100) });
          }
        };
        xhr.onload = () => {
          let data: { error?: string; storage?: StorageSnapshotDTO; file?: CloudFileDTO } = {};
          try {
            data = JSON.parse(xhr.responseText) as typeof data;
          } catch {
            data = {};
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            setNotice(`${data.file?.name ?? file.name} uploaded.`);
            if (data.storage) setStorage(data.storage);
          } else {
            setError(data.error ?? "Upload failed.");
          }
          resolve();
        };
        xhr.onerror = () => {
          setError("Upload failed — check your connection.");
          resolve();
        };
        xhr.send(form);
      });

      setUploading(null);
      await load({ silent: true });
      await refresh();
    },
    [load, refresh],
  );

  const openPreview = async (file: CloudFileDTO) => {
    setBusyId(file.id);
    try {
      const response = await fetch(`/api/files/${file.id}/url`, { cache: "no-store" });
      const data = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !data.url) {
        setError(data.error ?? "Could not open the preview.");
        return;
      }
      setPreview({ file, url: data.url });
    } finally {
      setBusyId(null);
    }
  };

  const submitRename = async () => {
    if (!renaming) return;
    setBusyId(renaming.id);
    try {
      const response = await fetch(`/api/files/${renaming.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: renameValue }),
      });
      const data = (await response.json()) as { error?: string; file?: CloudFileDTO };
      if (!response.ok) {
        setError(data.error ?? "Rename failed.");
        return;
      }
      setRenaming(null);
      setNotice("File renamed.");
      await load({ silent: true });
    } finally {
      setBusyId(null);
    }
  };

  const submitDelete = async () => {
    if (!deleting) return;
    setBusyId(deleting.id);
    try {
      const response = await fetch(`/api/files/${deleting.id}`, { method: "DELETE" });
      const data = (await response.json()) as { error?: string; storage?: StorageSnapshotDTO; reclaimedBytes?: number };
      if (!response.ok) {
        setError(data.error ?? "Delete failed.");
        return;
      }
      if (data.storage) setStorage(data.storage);
      setNotice(`Deleted. ${formatBytes(data.reclaimedBytes ?? 0)} of storage reclaimed.`);
      setDeleting(null);
      await load({ silent: true });
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const download = async (file: CloudFileDTO) => {
    setBusyId(file.id);
    try {
      const response = await fetch(`/api/files/${file.id}/url`, { cache: "no-store" });
      const data = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !data.url) {
        setError(data.error ?? "Download failed.");
        return;
      }
      const link = document.createElement("a");
      link.href = `${data.url}&disposition=attachment`;
      link.download = file.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      setBusyId(null);
    }
  };

  const percent = storage?.percentUsed ?? 0;
  const sortedLabel = useMemo(() => (order === "asc" ? "Ascending" : "Descending"), [order]);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card
          title="Upload a PDF"
          icon={<Upload size={17} className="text-blue-600" aria-hidden />}
          actions={!premium ? (
            <Link href="/pricing" className="rounded-lg bg-amber-400 px-2.5 py-1 text-xs font-bold text-amber-950 hover:bg-amber-300">
              Upgrade to {premiumQuotaLabel}
            </Link>
          ) : undefined}
        >
          {!session.user?.emailVerified ? (
            <Notice tone="warn">Verify your email address to enable cloud uploads.</Notice>
          ) : storage?.overQuota ? (
            <Notice tone="error">
              {storage.uploadsBlockedReason} Delete files to free space, or{" "}
              <Link href="/pricing" className="font-semibold underline">upgrade to Premium</Link>.
            </Notice>
          ) : (
            <Dropzone
              title={uploading ? `Uploading ${uploading.name}…` : "Drop a PDF here, or click to browse"}
              hint="Only PDF files. Files are stored privately and can be deleted at any time."
              accept="application/pdf,.pdf"
              disabled={Boolean(uploading)}
              onFiles={(list) => void upload(list)}
              compact
            />
          )}
          {uploading && (
            <div className="mt-3">
              <ProgressBar value={uploading.percent} label={`Uploading ${uploading.name}`} />
            </div>
          )}
          {error && (
            <div className="mt-3">
              <Notice tone="error">{error}</Notice>
            </div>
          )}
          {notice && (
            <div className="mt-3">
              <Notice tone="success">{notice}</Notice>
            </div>
          )}
        </Card>

        <Card title="Storage" icon={<FileText size={17} className="text-blue-600" aria-hidden />}>
          <p className="text-3xl font-black text-slate-900 dark:text-slate-50">
            {formatBytes(storage?.usedBytes ?? 0)}
            <span className="text-base font-semibold text-slate-500"> of {formatBytes(storage?.quotaBytes ?? 0)}</span>
          </p>
          <div className="mt-3">
            <ProgressBar value={percent} />
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Files</dt>
              <dd className="font-bold text-slate-900 dark:text-slate-100">{total}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Remaining</dt>
              <dd className="font-bold text-slate-900 dark:text-slate-100">{formatBytes(storage?.remainingBytes ?? 0)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Plan</dt>
              <dd className="font-bold text-slate-900 dark:text-slate-100">{premium ? "Premium" : "Free"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Max per file</dt>
              <dd className="font-bold text-slate-900 dark:text-slate-100">
                {formatBytes(session.entitlements?.maxUploadBytes ?? 0)}
              </dd>
            </div>
          </dl>
          {storage?.overQuota && (
            <p className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
              You are over your plan limit. Existing files stay available and uploads are paused until you free space.
            </p>
          )}
        </Card>
      </div>

      <Card
        title="Your files"
        icon={<FileText size={17} className="text-blue-600" aria-hidden />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-slate-400" aria-hidden />
              <input
                aria-label="Search files"
                placeholder="Search files"
                value={q}
                onChange={(event) => setQ(event.target.value)}
                className={`${inputCls} !w-48 !pl-8`}
              />
            </div>
            <select
              aria-label="Sort files by"
              value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
              className={`${inputCls} !w-auto`}
            >
              <option value="created">Upload date</option>
              <option value="name">Name</option>
              <option value="size">Size</option>
            </select>
            <button
              type="button"
              onClick={() => setOrder(order === "asc" ? "desc" : "asc")}
              className="rounded-lg border border-slate-300 p-2 text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300"
              aria-label={`Switch to ${order === "asc" ? "descending" : "ascending"} order (currently ${sortedLabel})`}
              title={`Currently ${sortedLabel}`}
            >
              {order === "asc" ? <ArrowUpAZ size={15} /> : <ArrowDownAZ size={15} />}
            </button>
            <Button size="sm" variant="secondary" onClick={() => void load()} aria-label="Refresh file list">
              <RefreshCw size={14} aria-hidden /> Refresh
            </Button>
          </div>
        }
      >
        {loading ? (
          <p className="flex items-center gap-2 py-8 text-sm text-slate-500">
            <Loader2 size={16} className="animate-spin" aria-hidden /> Loading your files…
          </p>
        ) : files.length === 0 ? (
          <EmptyState
            icon={<FileText size={28} aria-hidden />}
            title={q ? "No files match that search" : "No files yet"}
            text={q ? "Try a different name." : "Upload a PDF to keep it in your private cloud storage, available on every device."}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  <th className="px-2 py-2 font-semibold">Name</th>
                  <th className="px-2 py-2 font-semibold">Size</th>
                  <th className="px-2 py-2 font-semibold">Uploaded</th>
                  <th className="px-2 py-2 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="max-w-[320px] px-2 py-2">
                      <span className="flex items-center gap-2">
                        <FileText size={16} className="shrink-0 text-red-600" aria-hidden />
                        <span className="truncate font-medium text-slate-800 dark:text-slate-100" title={file.name}>
                          {file.name}
                        </span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-slate-600 dark:text-slate-300">{formatBytes(file.sizeBytes)}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-slate-600 dark:text-slate-300">
                      {new Date(file.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex justify-end gap-1">
                        <IconButton label={`Preview ${file.name}`} onClick={() => void openPreview(file)} busy={busyId === file.id}>
                          <Eye size={15} />
                        </IconButton>
                        <IconButton label={`Download ${file.name}`} onClick={() => void download(file)} busy={busyId === file.id}>
                          <Download size={15} />
                        </IconButton>
                        <IconButton
                          label={`Rename ${file.name}`}
                          onClick={() => {
                            setRenaming(file);
                            setRenameValue(file.name.replace(/\.pdf$/i, ""));
                          }}
                        >
                          <Pencil size={15} />
                        </IconButton>
                        <IconButton label={`Delete ${file.name}`} onClick={() => setDeleting(file)} danger>
                          <Trash2 size={15} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <AdSlot placement="cloud" />

      <Modal
        open={Boolean(preview)}
        onClose={() => setPreview(null)}
        title={preview?.file.name ?? "Preview"}
        wide
        footer={
          preview ? (
            <>
              <Button variant="secondary" onClick={() => setPreview(null)}>
                Close
              </Button>
              <Button variant="primary" onClick={() => void download(preview.file)}>
                <Download size={14} aria-hidden /> Download
              </Button>
            </>
          ) : undefined
        }
      >
        {preview && (
          <div className="space-y-2">
            <iframe src={preview.url} title={`Preview of ${preview.file.name}`} className="h-[60vh] w-full rounded-lg border border-slate-200 dark:border-slate-700" />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Preview uses a temporary signed link that expires in a few minutes.
            </p>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(renaming)}
        onClose={() => setRenaming(null)}
        title="Rename file"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void submitRename()} disabled={busyId === renaming?.id}>
              Save name
            </Button>
          </>
        }
      >
        <label className={labelCls} htmlFor="rename-input">File name</label>
        <input
          id="rename-input"
          className={inputCls}
          value={renameValue}
          maxLength={180}
          onChange={(event) => setRenameValue(event.target.value)}
          autoFocus
        />
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">.pdf is added automatically.</p>
      </Modal>

      <Modal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete file"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              Keep file
            </Button>
            <Button variant="danger" onClick={() => void submitDelete()} disabled={busyId === deleting?.id}>
              Delete permanently
            </Button>
          </>
        }
      >
        <p>
          Delete <strong>{deleting?.name}</strong>? This frees {formatBytes(deleting?.sizeBytes ?? 0)} of storage and cannot be undone.
        </p>
      </Modal>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
  busy,
  danger,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  busy?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={busy}
      className={`rounded p-1.5 disabled:opacity-50 ${
        danger
          ? "text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
          : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      }`}
    >
      {busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : children}
    </button>
  );
}
