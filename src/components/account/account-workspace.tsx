"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CreditCard, KeyRound, Laptop, Loader2, Receipt, RefreshCw, ShieldCheck, UserRound } from "lucide-react";
import { useSession } from "@/components/auth/session-provider";
import { Button, Card, Notice, ProgressBar, inputCls, labelCls } from "@/components/ui";
import { formatBytes, formatMoneyMinor } from "@/lib/plans";
import type { EntitlementsDTO, PaymentDTO, SessionDeviceDTO, SessionUserPublic } from "@/lib/session-types";

type Tab = "profile" | "security" | "billing" | "devices";

const TABS: { id: Tab; label: string; icon: typeof UserRound }[] = [
  { id: "profile", label: "Profile", icon: UserRound },
  { id: "security", label: "Password & security", icon: KeyRound },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "devices", label: "Devices", icon: Laptop },
];

export type ProfileData = {
  fullName: string | null;
  company: string | null;
  country: string | null;
  timezone: string | null;
  marketingOptIn: boolean;
};

const STATUS_TONE: Record<string, string> = {
  succeeded: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200",
  pending: "bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200",
  failed: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-200",
  refunded: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  cancelled: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
};

async function send<T>(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: T & { error?: string; message?: string } }> {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; message?: string };
  return { ok: response.ok, data };
}

export function AccountWorkspace({
  user,
  entitlements,
  profile,
  sessions,
  payments,
  initialTab,
}: {
  user: SessionUserPublic;
  entitlements: EntitlementsDTO;
  profile: ProfileData | null;
  sessions: SessionDeviceDTO[];
  payments: PaymentDTO[];
  initialTab: Tab;
}) {
  const router = useRouter();
  const { refresh } = useSession();
  const [tab, setTab] = useState<Tab>(initialTab);

  return (
    <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
      <nav aria-label="Account sections" className="flex gap-1 overflow-x-auto lg:flex-col">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-current={tab === id ? "page" : undefined}
            className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${
              tab === id
                ? "bg-blue-600 text-white"
                : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
            }`}
          >
            <Icon size={15} aria-hidden /> {label}
          </button>
        ))}
      </nav>

      <div className="space-y-5">
        {tab === "profile" && <ProfilePanel user={user} profile={profile} onSaved={() => router.refresh()} />}
        {tab === "security" && <SecurityPanel user={user} />}
        {tab === "billing" && <BillingPanel entitlements={entitlements} payments={payments} />}
        {tab === "devices" && <DevicesPanel sessions={sessions} onChanged={() => router.refresh()} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ProfilePanel({ user, profile, onSaved }: { user: SessionUserPublic; profile: ProfileData | null; onSaved: () => void }) {
  const { refresh } = useSession();
  const [form, setForm] = useState({
    displayName: user.displayName ?? "",
    fullName: profile?.fullName ?? "",
    company: profile?.company ?? "",
    country: profile?.country ?? "",
    timezone: profile?.timezone ?? "",
    marketingOptIn: profile?.marketingOptIn ?? false,
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    const { ok, data } = await send<{ message?: string }>("/api/account", "PATCH", form);
    setBusy(false);
    if (!ok) {
      setError(data.error ?? "Could not save your profile.");
      return;
    }
    setMessage(data.message ?? "Profile updated.");
    await refresh();
    onSaved();
  };

  return (
    <Card title="Profile" icon={<UserRound size={17} className="text-blue-600" aria-hidden />}>
      <form onSubmit={save} className="space-y-4">
        {error && <Notice tone="error">{error}</Notice>}
        {message && <Notice tone="success">{message}</Notice>}
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className={labelCls}>Email address</dt>
            <dd className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {user.email}
              <span className={`ml-2 text-[11px] font-bold ${user.emailVerified ? "text-emerald-600" : "text-amber-600"}`}>
                {user.emailVerified ? "verified" : "unverified"}
              </span>
            </dd>
          </div>
          <div>
            <dt className={labelCls}>Account type</dt>
            <dd className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm capitalize text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {entitlementsLabel(user.plan)}
            </dd>
          </div>
        </dl>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="profile-name">Display name</label>
            <input
              id="profile-name"
              className={inputCls}
              maxLength={80}
              value={form.displayName}
              onChange={(event) => setForm({ ...form, displayName: event.target.value })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="profile-full">Full name</label>
            <input
              id="profile-full"
              className={inputCls}
              maxLength={120}
              value={form.fullName}
              onChange={(event) => setForm({ ...form, fullName: event.target.value })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="profile-company">Company</label>
            <input
              id="profile-company"
              className={inputCls}
              maxLength={120}
              value={form.company}
              onChange={(event) => setForm({ ...form, company: event.target.value })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="profile-country">Country</label>
            <input
              id="profile-country"
              className={inputCls}
              maxLength={60}
              value={form.country}
              onChange={(event) => setForm({ ...form, country: event.target.value })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="profile-timezone">Time zone</label>
            <input
              id="profile-timezone"
              className={inputCls}
              maxLength={60}
              placeholder="Asia/Karachi"
              value={form.timezone}
              onChange={(event) => setForm({ ...form, timezone: event.target.value })}
            />
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.marketingOptIn}
            onChange={(event) => setForm({ ...form, marketingOptIn: event.target.checked })}
          />
          <span>Send me occasional product updates.</span>
        </label>

        <Button type="submit" variant="primary" disabled={busy}>
          {busy && <Loader2 size={14} className="animate-spin" aria-hidden />} Save profile
        </Button>
      </form>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function SecurityPanel({ user }: { user: SessionUserPublic }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (next !== confirm) {
      setError("The two new passwords do not match.");
      return;
    }
    setBusy(true);
    const { ok, data } = await send<{ message?: string }>("/api/auth/password", "POST", {
      currentPassword: current || undefined,
      newPassword: next,
    });
    setBusy(false);
    if (!ok) {
      setError(data.error ?? "Could not change your password.");
      return;
    }
    setMessage(data.message ?? "Password updated.");
    setCurrent("");
    setNext("");
    setConfirm("");
  };

  return (
    <Card title="Password & security" icon={<KeyRound size={17} className="text-blue-600" aria-hidden />}>
      <form onSubmit={submit} className="space-y-3">
        {error && <Notice tone="error">{error}</Notice>}
        {message && <Notice tone="success">{message}</Notice>}
        {!user.emailVerified && (
          <Notice tone="warn">Your email is not verified yet. Verification unlocks cloud uploads and checkout.</Notice>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className={labelCls} htmlFor="current-password">Current password</label>
            <input
              id="current-password"
              className={inputCls}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              placeholder={user.emailVerified ? "" : "not set for Google accounts"}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="new-password">New password</label>
            <input
              id="new-password"
              className={inputCls}
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={next}
              onChange={(event) => setNext(event.target.value)}
              required
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="confirm-password">Confirm new password</label>
            <input
              id="confirm-password"
              className={inputCls}
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              required
            />
          </div>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          At least 10 characters with a letter and a number. Changing your password signs out every other device.
        </p>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy && <Loader2 size={14} className="animate-spin" aria-hidden />} Update password
        </Button>
      </form>
      <div className="mt-5 rounded-xl border border-slate-200 p-3 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
        <p className="flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
          <ShieldCheck size={14} aria-hidden /> How your account is protected
        </p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>Passwords are hashed with scrypt and a unique salt; the plain password is never stored.</li>
          <li>Sessions live in the database and are revoked immediately on sign-out.</li>
          <li>Only one account can ever access its own files — ownership is checked on every request.</li>
        </ul>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function BillingPanel({ entitlements, payments }: { entitlements: EntitlementsDTO; payments: PaymentDTO[] }) {
  const router = useRouter();
  const { refresh } = useSession();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const subscription = entitlements.subscription;
  const premium = entitlements.plan === "premium";

  const cancel = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    const { ok, data } = await send<{ message?: string }>("/api/billing/cancel", "POST", {});
    setBusy(false);
    setConfirming(false);
    if (!ok) {
      setError(data.error ?? "Could not cancel the subscription.");
      return;
    }
    setMessage(data.message ?? "Subscription cancelled.");
    await refresh();
    router.refresh();
  };

  return (
    <div className="space-y-5">
      <Card title="Subscription" icon={<CreditCard size={17} className="text-blue-600" aria-hidden />}>
        {error && <Notice tone="error">{error}</Notice>}
        {message && <Notice tone="success">{message}</Notice>}
        <div className="space-y-2 text-sm">
          <p className="text-lg font-bold text-slate-900 dark:text-slate-100">
            {premium ? (subscription?.planName ?? "Premium") : "Free plan"}
          </p>
          <p className="text-slate-600 dark:text-slate-300">
            {formatBytes(entitlements.storage.usedBytes)} of {formatBytes(entitlements.quotaBytes)} used
          </p>
          <ProgressBar value={entitlements.storage.percentUsed} />
          {subscription && (
            <dl className="mt-3 grid gap-2 sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Status</dt>
                <dd className="font-semibold capitalize">{subscription.status.replace("_", " ")}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Billing</dt>
                <dd className="font-semibold">
                  {subscription.interval === "year" ? "Yearly" : "Monthly"} ·{" "}
                  {subscription.billingMode === "recurring" ? "recurring" : "one-time"}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Current period ends</dt>
                <dd className="font-semibold">
                  {subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd).toLocaleString() : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Renewal</dt>
                <dd className="font-semibold">
                  {subscription.billingMode === "recurring" && !subscription.cancelAtPeriodEnd ? "Automatic" : "Does not renew"}
                </dd>
              </div>
            </dl>
          )}
          {entitlements.inGracePeriod && (
            <Notice tone="warn">
              A renewal payment could not be confirmed. Premium continues during the grace period — please review your
              payment method.
            </Notice>
          )}
          {premium && subscription?.cancelAtPeriodEnd && (
            <Notice tone="warn">Cancelled. Premium ends when the current period finishes.</Notice>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {premium ? (
              subscription?.cancelAtPeriodEnd ? (
                <Link href="/pricing" className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500">
                  Resume Premium
                </Link>
              ) : (
                confirming ? (
                  <>
                    <Button variant="danger" size="sm" onClick={() => void cancel()} disabled={busy}>
                      {busy && <Loader2 size={13} className="animate-spin" aria-hidden />} Confirm cancellation
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
                      Keep subscription
                    </Button>
                  </>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
                    Cancel subscription
                  </Button>
                )
              )
            ) : (
              <Link href="/pricing" className="rounded-lg bg-amber-400 px-3 py-2 text-xs font-bold text-amber-950 hover:bg-amber-300">
                Upgrade to Premium
              </Link>
            )}
            <Button variant="secondary" size="sm" onClick={() => void refresh()} aria-label="Refresh billing status">
              <RefreshCw size={13} aria-hidden /> Refresh
            </Button>
          </div>
          {confirming && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Your Premium benefits stay until the end of the paid term; your files are never deleted.
            </p>
          )}
        </div>
      </Card>

      <Card title="Payment history" icon={<Receipt size={17} className="text-blue-600" aria-hidden />}>
        {payments.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">No payments yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  <th className="px-2 py-2">Date</th>
                  <th className="px-2 py-2">Plan</th>
                  <th className="px-2 py-2">Amount</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">Reference</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="whitespace-nowrap px-2 py-2">{new Date(payment.createdAt).toLocaleDateString()}</td>
                    <td className="px-2 py-2">{payment.planName}</td>
                    <td className="whitespace-nowrap px-2 py-2 font-semibold">{formatMoneyMinor(payment.amountMinor, payment.currency)}</td>
                    <td className="px-2 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold capitalize ${STATUS_TONE[payment.status] ?? ""}`}>
                        {payment.status}
                      </span>
                      {payment.failureReason && (
                        <span className="ml-1 text-[11px] text-slate-500">{payment.failureReason.slice(0, 60)}</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-xs text-slate-500">{payment.reference ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function DevicesPanel({ sessions, onChanged }: { sessions: SessionDeviceDTO[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const revoke = async (sessionId: string) => {
    setBusy(sessionId);
    setError(null);
    const { ok, data } = await send<{ message?: string }>("/api/account/sessions", "POST", { sessionId });
    setBusy(null);
    if (!ok) {
      setError(data.error ?? "Could not revoke that session.");
      return;
    }
    setMessage("Device signed out.");
    onChanged();
  };

  const revokeAll = async () => {
    setBusy("all");
    setError(null);
    const { ok, data } = await send<{ message?: string }>("/api/account/sessions", "POST", { all: true });
    setBusy(null);
    if (!ok) {
      setError(data.error ?? "Could not sign out the other devices.");
      return;
    }
    setMessage(data.message ?? "Other devices signed out.");
    onChanged();
  };

  return (
    <Card
      title="Signed-in devices"
      icon={<Laptop size={17} className="text-blue-600" aria-hidden />}
      actions={
        <Button variant="secondary" size="sm" onClick={() => void revokeAll()} disabled={busy === "all"}>
          {busy === "all" && <Loader2 size={13} className="animate-spin" aria-hidden />} Sign out other devices
        </Button>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
        {sessions.map((device) => (
          <li key={device.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <span>
              <span className="font-semibold text-slate-800 dark:text-slate-100">{device.device}</span>
              <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                last active {new Date(device.lastSeenAt).toLocaleString()}
              </span>
            </span>
            <Button variant="secondary" size="sm" onClick={() => void revoke(device.id)} disabled={busy === device.id}>
              {busy === device.id ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null} Revoke
            </Button>
          </li>
        ))}
        {sessions.length === 0 && <li className="py-2 text-sm text-slate-500">No active sessions found.</li>}
      </ul>
    </Card>
  );
}

function entitlementsLabel(plan: string): string {
  return plan === "premium" ? "Premium" : "Free";
}
