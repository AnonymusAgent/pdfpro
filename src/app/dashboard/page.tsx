import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  BadgeCheck,
  CalendarClock,
  CloudUpload,
  CreditCard,
  Crown,
  FileText,
  Receipt,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { AdSlot } from "@/components/ads/ad-slot";
import { QuickUpload } from "@/components/cloud/quick-upload";
import { Card, Notice, PageTitle, ProgressBar } from "@/components/ui";
import { getEntitlements } from "@/lib/server/entitlements";
import { listUserPayments } from "@/lib/server/payments/billing";
import { listUserFiles } from "@/lib/server/files";
import { readSession } from "@/lib/server/session";
import { formatBytes, formatMoneyMinor } from "@/lib/plans";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  succeeded: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200",
  pending: "bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200",
  failed: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-200",
  refunded: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  cancelled: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ preview?: string; welcome?: string }>;
}) {
  const session = await readSession().catch(() => null);
  if (!session) redirect("/login?next=/dashboard");
  const { preview } = await searchParams;

  const [entitlements, files, payments] = await Promise.all([
    getEntitlements(session.user.id),
    listUserFiles(session.user.id, { limit: 5 }).catch(() => ({ files: [], total: 0 })),
    listUserPayments(session.user.id, 3).catch(() => []),
  ]);

  const premium = entitlements.plan === "premium";
  const subscription = entitlements.subscription;
  const remainingLabel = formatBytes(entitlements.storage.remainingBytes);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-8">
      <PageTitle
        title={`Welcome back${session.user.displayName ? `, ${session.user.displayName}` : ""}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {session.user.email}
            {premium ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
                <Crown size={11} aria-hidden /> Premium
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                Free plan
              </span>
            )}
            {session.user.emailVerified ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                <BadgeCheck size={12} aria-hidden /> Email verified
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                <TriangleAlert size={12} aria-hidden /> Email not verified
              </span>
            )}
          </span>
        }
        actions={<QuickUpload />}
      />

      {!session.user.emailVerified && (
        <Notice tone="warn">
          Verify <strong>{session.user.email}</strong> to upload files and subscribe. Use “Resend link” in the banner
          above; the email arrives from the address configured by the administrator.
        </Notice>
      )}
      {preview && (
        <Notice tone="warn">
          Development mail transport is active, so the verification link is shown here:{" "}
          <a className="break-all font-semibold underline" href={preview}>
            {preview}
          </a>
          . Configure SMTP or Resend to deliver email normally.
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Storage" icon={<CloudUpload size={17} className="text-blue-600" aria-hidden />} className="lg:col-span-2">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <p className="text-3xl font-black text-slate-900 dark:text-slate-50">
              {formatBytes(entitlements.storage.usedBytes)}
              <span className="text-base font-semibold text-slate-500"> of {formatBytes(entitlements.storage.quotaBytes)}</span>
            </p>
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">{remainingLabel} remaining</p>
          </div>
          <div className="mt-3">
            <ProgressBar value={entitlements.storage.percentUsed} />
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Files</dt>
              <dd className="font-bold text-slate-900 dark:text-slate-100">{entitlements.storage.fileCount}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Plan</dt>
              <dd className="font-bold text-slate-900 dark:text-slate-100">{premium ? "Premium" : "Free"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Quota</dt>
              <dd className="font-bold text-slate-900 dark:text-slate-100">{formatBytes(entitlements.quotaBytes)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Max upload</dt>
              <dd className="font-bold text-slate-900 dark:text-slate-100">{formatBytes(entitlements.maxUploadBytes)}</dd>
            </div>
          </dl>
          {entitlements.storage.overQuota && (
            <p className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
              You are over the {premium ? "Premium" : "Free"} limit. Files are preserved; uploads resume once usage drops
              below {formatBytes(entitlements.quotaBytes)}.{" "}
              <Link href="/cloud" className="font-semibold underline">Manage files</Link>.
            </p>
          )}
        </Card>

        <Card title="Subscription" icon={<CreditCard size={17} className="text-blue-600" aria-hidden />}>
          {premium ? (
            <div className="space-y-2 text-sm">
              <p className="text-lg font-bold text-slate-900 dark:text-slate-100">{subscription?.planName ?? "Premium"}</p>
              <p className="text-slate-600 dark:text-slate-300">
                Status: <strong className="capitalize">{subscription?.status.replace("_", " ")}</strong>
                {entitlements.inGracePeriod && " (grace period)"}
              </p>
              {subscription?.currentPeriodEnd && (
                <p className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                  <CalendarClock size={14} aria-hidden /> Access until{" "}
                  {new Date(subscription.currentPeriodEnd).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
                </p>
              )}
              {subscription?.cancelAtPeriodEnd && (
                <Notice tone="warn">Cancelled — Premium ends at the close of the paid term.</Notice>
              )}
              <Link href="/account?tab=billing" className="inline-block rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800">
                Manage billing
              </Link>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="text-slate-600 dark:text-slate-300">
                Free plan · 2 GB storage · advertisements shown. Upgrade for 10 GB and an ad-free workspace.
              </p>
              <Link
                href="/pricing"
                className="inline-flex items-center gap-2 rounded-lg bg-amber-400 px-3 py-2 text-xs font-bold text-amber-950 hover:bg-amber-300"
              >
                <Sparkles size={14} aria-hidden /> Upgrade to Premium
              </Link>
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          title="Recent files"
          icon={<FileText size={17} className="text-blue-600" aria-hidden />}
          className="lg:col-span-2"
          actions={
            <Link href="/cloud" className="text-xs font-semibold text-blue-700 hover:underline dark:text-blue-300">
              View all
            </Link>
          }
        >
          {files.files.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-600">
              No cloud files yet. Upload a PDF to store it privately and open it on any device.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {files.files.map((file) => (
                <li key={file.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <FileText size={15} className="shrink-0 text-red-600" aria-hidden />
                    <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{file.name}</span>
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {formatBytes(file.sizeBytes)} ·{" "}
                    {new Date(file.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Quick actions" icon={<ShieldCheck size={17} className="text-blue-600" aria-hidden />}>
          <ul className="space-y-2 text-sm">
            {[
              { href: "/editor", label: "Edit a PDF in the browser" },
              { href: "/convert", label: "Convert a document" },
              { href: "/account", label: "Account settings" },
              { href: "/cloud", label: "Manage cloud files" },
              { href: "/pricing", label: "Compare plans" },
            ].map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800">
                  <span>{item.label}</span>
                  <span aria-hidden>→</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {payments.length > 0 && (
        <Card
          title="Payment history"
          icon={<Receipt size={17} className="text-blue-600" aria-hidden />}
          actions={
            <Link href="/account?tab=billing" className="text-xs font-semibold text-blue-700 hover:underline dark:text-blue-300">
              All payments
            </Link>
          }
        >
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {payments.map((payment) => (
              <li key={payment.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-semibold text-slate-800 dark:text-slate-100">{payment.planName}</span>
                  <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                    {new Date(payment.createdAt).toLocaleDateString()}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-semibold">{formatMoneyMinor(payment.amountMinor, payment.currency)}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold capitalize ${STATUS_TONE[payment.status] ?? ""}`}>
                    {payment.status}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <AdSlot placement="dashboard" />
    </div>
  );
}
