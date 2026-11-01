import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { CloudUpload } from "lucide-react";
import { CloudFileManager } from "@/components/cloud/file-manager";
import { PageTitle } from "@/components/ui";
import { getEntitlements } from "@/lib/server/entitlements";
import { readSession } from "@/lib/server/session";

export const metadata: Metadata = { title: "Cloud storage" };
export const dynamic = "force-dynamic";

export default async function CloudPage() {
  const session = await readSession().catch(() => null);
  if (!session) redirect("/login?next=/cloud");
  const entitlements = await getEntitlements(session.user.id);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8">
      <PageTitle
        title="Cloud storage"
        description={
          <span>
            Private PDF storage for {session.user.email}.{" "}
            {entitlements.plan === "premium" ? "Premium plan" : "Free plan"} ·{" "}
            {entitlements.storage.quotaBytes / 1_000_000_000} GB quota.
          </span>
        }
        actions={
          <span className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-800 dark:bg-blue-950/50 dark:text-blue-200">
            <CloudUpload size={14} aria-hidden /> Only your account can see these files
          </span>
        }
      />
      <CloudFileManager initialStorage={entitlements.storage} />
      <p className="mt-6 text-xs text-slate-500 dark:text-slate-400">
        Looking for the browser-only tools?{" "}
        <Link href="/editor" className="font-semibold underline">Open the editor</Link> — files processed there never leave your device.
      </p>
    </div>
  );
}
