"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { Loader2, Upload } from "lucide-react";
import { useSession } from "@/components/auth/session-provider";
import { ProgressBar } from "@/components/ui";

/**
 * Compact upload control used on the dashboard. Quota and file validation are
 * enforced by the server; the client only reports what happened.
 */
export function QuickUpload() {
  const router = useRouter();
  const { session, refresh } = useSession();
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const blocked = !session.user?.emailVerified
    ? "Verify your email address to upload files."
    : session.entitlements?.storage.overQuota
      ? session.entitlements.storage.uploadsBlockedReason
      : null;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (blocked) {
      setError(blocked);
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    setPercent(0);
    await new Promise<void>((resolve) => {
      const form = new FormData();
      form.append("file", file);
      form.append("name", file.name);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/files");
      xhr.withCredentials = true;
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) setPercent(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => {
        let data: { error?: string } = {};
        try {
          data = JSON.parse(xhr.responseText) as typeof data;
        } catch {
          data = {};
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          setMessage(`${file.name} is now in your cloud storage.`);
          router.refresh();
          void refresh();
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
    setBusy(false);
    setPercent(0);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <label
          className={`inline-flex cursor-pointer items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold text-white ${
            busy || blocked ? "cursor-not-allowed bg-blue-400" : "bg-blue-600 hover:bg-blue-500"
          }`}
        >
          {busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Upload size={15} aria-hidden />}
          {busy ? "Uploading…" : "Upload PDF"}
          <input
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            disabled={busy || Boolean(blocked)}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              void upload(file);
            }}
          />
        </label>
        <Link
          href="/cloud"
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        >
          Open cloud storage
        </Link>
      </div>
      {busy && <ProgressBar value={percent} label="Uploading" />}
      {blocked && !error && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {blocked}{" "}
          <Link href="/pricing" className="font-semibold underline">
            See plans
          </Link>
          .
        </p>
      )}
      {message && <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">{message}</p>}
      {error && <p role="alert" className="text-xs font-semibold text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
