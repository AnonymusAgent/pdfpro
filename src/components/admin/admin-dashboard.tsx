"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  BadgeDollarSign,
  Crown,
  Database,
  FileText,
  Loader2,
  Mail,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Users,
  Webhook,
} from "lucide-react";
import { Button, Card, Notice, inputCls, labelCls } from "@/components/ui";
import { formatBytes, formatMoneyMinor } from "@/lib/plans";
import type { PlanDTO } from "@/lib/session-types";

type Stats = {
  users: { total: number; free: number; premium: number; verified: number; newLast30Days: number };
  subscriptions: { active: number; pastDue: number };
  revenue: { currency: string; mrrMinor: number; annualPlanMinor: number; succeededPayments: number; failedPayments: number; totalPayments: number; revenue30dMinor: number; totalRevenueMinor: number }[];
  payments: { succeeded: number; failed: number; total: number };
  storage: { files: number; bytes: number };
  webhooks: { total: number; failed: number; last24h: number };
};

type AdminUser = {
  id: string;
  email: string;
  displayName: string | null;
  plan: string;
  accountStatus: string;
  emailVerified: boolean;
  createdAt: string;
  usedBytes: number;
  fileCount: number;
  role: string | null;
  subscription: { status: string; plan: string | null; periodEnd: string | null } | null;
};

type AdminPayment = {
  id: string;
  email: string;
  planName: string | null;
  amountMinor: number;
  currency: string;
  status: string;
  provider: string;
  reference: string | null;
  failureReason: string | null;
  createdAt: string;
  paidAt: string | null;
};

type AdminSubscription = {
  id: string;
  email: string;
  planName: string | null;
  status: string;
  billingMode: string;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
};

type OutboxEmail = { id: string; to: string; subject: string; body: string; kind: string; transport: string; status: string; createdAt: string };
type WebhookEvent = { id: string; eventType: string | null; signatureValid: boolean; status: string; error: string | null; receivedAt: string };

type AdsenseSettings = { enabled: boolean; publisherId: string; slots: Record<string, string>; requireConsent: boolean };
type BillingSettings = { graceDays: number; paused: boolean; supportEmail: string; prorationNote: string };
type StorageSettings = { maxUploadBytes: number };

type Tab = "overview" | "users" | "subscriptions" | "payments" | "plans" | "adsense" | "ops";

const TABS: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: "overview", label: "Overview", icon: Database },
  { id: "users", label: "Users", icon: Users },
  { id: "subscriptions", label: "Subscriptions", icon: Crown },
  { id: "payments", label: "Payments", icon: BadgeDollarSign },
  { id: "plans", label: "Pricing", icon: Settings2 },
  { id: "adsense", label: "AdSense & settings", icon: ShieldCheck },
  { id: "ops", label: "Email & webhooks", icon: Webhook },
];

async function getJson<T>(url: string): Promise<{ ok: boolean; data: T & { error?: string } }> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  return { ok: response.ok, data };
}

async function mutate<T>(url: string, method: string, body: unknown): Promise<{ ok: boolean; data: T & { error?: string; message?: string } }> {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; message?: string };
  return { ok: response.ok, data };
}

export function AdminDashboard({ adminEmail }: { adminEmail: string }) {
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
        <span className="flex items-center gap-2 font-semibold">
          <ShieldCheck size={14} aria-hidden /> Administrator session · {adminEmail}
        </span>
        <span>Role checks run on the server for every admin request.</span>
      </div>

      <nav aria-label="Admin sections" className="flex gap-1 overflow-x-auto">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-current={tab === id ? "page" : undefined}
            className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${
              tab === id ? "bg-slate-900 text-white dark:bg-slate-700" : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
            }`}
          >
            <Icon size={15} aria-hidden /> {label}
          </button>
        ))}
      </nav>

      {tab === "overview" && <Overview />}
      {tab === "users" && <UsersPanel />}
      {tab === "subscriptions" && <SubscriptionsPanel />}
      {tab === "payments" && <PaymentsPanel />}
      {tab === "plans" && <PlansPanel />}
      {tab === "adsense" && <SettingsPanel />}
      {tab === "ops" && <OpsPanel />}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Overview() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await getJson<Stats>("/api/admin/stats");
    if (!ok) setError(data.error ?? "Could not load statistics.");
    else {
      setStats(data);
      setError(null);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const runLifecycle = async () => {
    setBusy(true);
    const { ok, data } = await mutate<{ message?: string }>("/api/admin/subscriptions", "POST", { action: "sync" });
    setBusy(false);
    setMessage(ok ? (data.message ?? "Lifecycle synchronised.") : (data.error ?? "Could not run the lifecycle job."));
    await load();
  };

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!stats) return <Loading label="Loading statistics" />;

  const primary = stats.revenue[0];

  return (
    <div className="space-y-5">
      {message && <Notice tone="success">{message}</Notice>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Registered users" value={String(stats.users.total)} hint={`${stats.users.newLast30Days} new in 30 days`} icon={<Users size={16} aria-hidden />} />
        <Metric label="Free accounts" value={String(stats.users.free)} hint={`${stats.users.verified} email-verified`} icon={<Users size={16} aria-hidden />} />
        <Metric label="Premium accounts" value={String(stats.users.premium)} hint={`${stats.subscriptions.active} active subscription(s)`} icon={<Crown size={16} aria-hidden />} />
        <Metric
          label="Monthly recurring revenue"
          value={primary ? formatMoneyMinor(primary.mrrMinor, primary.currency) : "—"}
          hint={stats.subscriptions.pastDue > 0 ? `${stats.subscriptions.pastDue} past due` : "No failed renewals"}
          icon={<BadgeDollarSign size={16} aria-hidden />}
        />
        <Metric
          label="Annual plan revenue"
          value={primary ? formatMoneyMinor(primary.annualPlanMinor, primary.currency) : "—"}
          hint="Active yearly subscriptions"
          icon={<BadgeDollarSign size={16} aria-hidden />}
        />
        <Metric
          label="Total payments"
          value={String(stats.payments.total)}
          hint={`${stats.payments.succeeded} succeeded · ${stats.payments.failed} failed`}
          icon={<BadgeDollarSign size={16} aria-hidden />}
        />
        <Metric
          label="Uploaded files"
          value={String(stats.storage.files)}
          hint={`${formatBytes(stats.storage.bytes)} stored`}
          icon={<FileText size={16} aria-hidden />}
        />
        <Metric
          label="Webhook deliveries"
          value={String(stats.webhooks.total)}
          hint={`${stats.webhooks.last24h} in 24h · ${stats.webhooks.failed} failed`}
          icon={<Webhook size={16} aria-hidden />}
        />
      </div>

      {stats.revenue.length > 1 && (
        <Card title="Revenue by currency">
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {stats.revenue.map((row) => (
              <li key={row.currency} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="font-semibold">{row.currency}</span>
                <span>
                  MRR {formatMoneyMinor(row.mrrMinor, row.currency)} · 30-day {formatMoneyMinor(row.revenue30dMinor, row.currency)} · total{" "}
                  {formatMoneyMinor(row.totalRevenueMinor, row.currency)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Maintenance">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Expire subscriptions whose paid term ended, finish pending file deletions and prune counters. The same job runs
          from the scheduler with <code>POST /api/cron/maintenance</code>.
        </p>
        <Button variant="primary" className="mt-3" onClick={() => void runLifecycle()} disabled={busy}>
          {busy && <Loader2 size={14} className="animate-spin" aria-hidden />} Run lifecycle now
        </Button>
      </Card>
    </div>
  );
}

function Metric({ label, value, hint, icon }: { label: string; value: string; hint: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {icon} {label}
      </p>
      <p className="mt-1 text-2xl font-black text-slate-900 dark:text-slate-50">{value}</p>
      <p className="text-[11px] text-slate-500 dark:text-slate-400">{hint}</p>
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 py-6 text-sm text-slate-500">
      <Loader2 size={15} className="animate-spin" aria-hidden /> {label}…
    </p>
  );
}

/* ------------------------------------------------------------------ */

function UsersPanel() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await getJson<{ users: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(q)}&limit=100`);
    setLoading(false);
    if (!ok) setError((data as { error?: string }).error ?? "Could not load users.");
    else {
      setUsers(data.users ?? []);
      setError(null);
    }
  }, [q]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  const act = async (userId: string, action: string, value?: string) => {
    setBusyId(userId);
    const { ok, data } = await mutate<{ message?: string }>("/api/admin/users", "PATCH", { userId, action, value });
    setBusyId(null);
    setMessage(ok ? (data.message ?? "Updated.") : (data.error ?? "Update failed."));
    await load();
  };

  return (
    <Card
      title="User management"
      actions={
        <div className="flex items-center gap-2">
          <input
            aria-label="Search users"
            placeholder="Search email or name"
            className={`${inputCls} !w-56`}
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            <RefreshCw size={13} aria-hidden /> Refresh
          </Button>
        </div>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      {loading ? (
        <Loading label="Loading users" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <th className="px-2 py-2">Account</th>
                <th className="px-2 py-2">Plan</th>
                <th className="px-2 py-2">Storage</th>
                <th className="px-2 py-2">Subscription</th>
                <th className="px-2 py-2">Role</th>
                <th className="px-2 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-2 py-2">
                    <p className="font-semibold text-slate-800 dark:text-slate-100">{user.email}</p>
                    <p className="text-[11px] text-slate-500">
                      {user.displayName ?? "—"} · joined {new Date(user.createdAt).toLocaleDateString()} ·{" "}
                      {user.emailVerified ? "verified" : "unverified"}
                    </p>
                  </td>
                  <td className="px-2 py-2 capitalize">{user.plan}</td>
                  <td className="px-2 py-2 text-xs">
                    {formatBytes(user.usedBytes)} · {user.fileCount} file(s)
                  </td>
                  <td className="px-2 py-2 text-xs">
                    {user.subscription
                      ? `${user.subscription.status}${user.subscription.plan ? ` · ${user.subscription.plan}` : ""}${
                          user.subscription.periodEnd ? ` · ${new Date(user.subscription.periodEnd).toLocaleDateString()}` : ""
                        }`
                      : "—"}
                  </td>
                  <td className="px-2 py-2">
                    {user.role ? (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-bold text-blue-800 dark:bg-blue-950/60 dark:text-blue-200">
                        {user.role}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-500">user</span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      {busyId === user.id ? (
                        <Loader2 size={14} className="animate-spin" aria-hidden />
                      ) : (
                        <>
                          {user.role ? (
                            <SmallButton onClick={() => void act(user.id, "revoke_admin")}>Remove admin</SmallButton>
                          ) : (
                            <SmallButton onClick={() => void act(user.id, "grant_admin")}>Make admin</SmallButton>
                          )}
                          {user.accountStatus === "active" ? (
                            <SmallButton danger onClick={() => void act(user.id, "suspend")}>Suspend</SmallButton>
                          ) : (
                            <SmallButton onClick={() => void act(user.id, "activate")}>Reactivate</SmallButton>
                          )}
                          {user.subscription && ["active", "past_due"].includes(user.subscription.status) && (
                            <SmallButton danger onClick={() => void act(user.id, "suspend")}>
                              End subscription
                            </SmallButton>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function SmallButton({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-1.5 py-0.5 text-[11px] font-semibold ${
        danger
          ? "border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300"
          : "border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */

function SubscriptionsPanel() {
  const [rows, setRows] = useState<AdminSubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await getJson<{ subscriptions: AdminSubscription[] }>("/api/admin/subscriptions?limit=100");
    setRows(data.subscriptions ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const cancelNow = async (email: string) => {
    const user = rows.find((row) => row.email === email);
    if (!user) return;
    const usersResponse = await getJson<{ users: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(email)}&limit=5`);
    const match = usersResponse.data.users?.find((candidate) => candidate.email === email);
    if (!match) return;
    const { ok, data } = await mutate<{ message?: string }>("/api/admin/subscriptions", "POST", {
      action: "cancel_now",
      userId: match.id,
    });
    setMessage(ok ? (data.message ?? "Subscription ended.") : (data.error ?? "Could not end the subscription."));
    await load();
  };

  return (
    <Card title="Subscriptions">
      {message && <Notice tone="success">{message}</Notice>}
      {loading ? (
        <Loading label="Loading subscriptions" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">No subscriptions yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <th className="px-2 py-2">Customer</th>
                <th className="px-2 py-2">Plan</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Billing</th>
                <th className="px-2 py-2">Period ends</th>
                <th className="px-2 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-2 py-2 font-medium">{row.email}</td>
                  <td className="px-2 py-2">{row.planName ?? "—"}</td>
                  <td className="px-2 py-2">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold capitalize dark:bg-slate-800">
                      {row.status.replace("_", " ")}
                    </span>
                    {row.cancelAtPeriodEnd && <span className="ml-1 text-[11px] text-amber-700">cancels</span>}
                  </td>
                  <td className="px-2 py-2 text-xs">{row.billingMode === "recurring" ? "Recurring" : "One-time"}</td>
                  <td className="px-2 py-2 text-xs">{row.periodEnd ? new Date(row.periodEnd).toLocaleString() : "—"}</td>
                  <td className="px-2 py-2 text-right">
                    {["active", "past_due"].includes(row.status) && (
                      <SmallButton danger onClick={() => void cancelNow(row.email)}>
                        End now
                      </SmallButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function PaymentsPanel() {
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<AdminPayment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await getJson<{ payments: AdminPayment[] }>(`/api/admin/payments?limit=100&status=${status}`);
    setRows(data.payments ?? []);
    setLoading(false);
  }, [status]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <Card
      title="Payment reports"
      actions={
        <div className="flex items-center gap-2">
          <select aria-label="Filter by payment status" className={`${inputCls} !w-auto`} value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All statuses</option>
            <option value="succeeded">Succeeded</option>
            <option value="pending">Pending</option>
            <option value="failed">Failed</option>
            <option value="refunded">Refunded</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            <RefreshCw size={13} aria-hidden /> Refresh
          </Button>
        </div>
      }
    >
      {loading ? (
        <Loading label="Loading payments" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">No payments recorded.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <th className="px-2 py-2">Date</th>
                <th className="px-2 py-2">Customer</th>
                <th className="px-2 py-2">Plan</th>
                <th className="px-2 py-2">Amount</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Reference</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="whitespace-nowrap px-2 py-2 text-xs">{new Date(row.createdAt).toLocaleString()}</td>
                  <td className="px-2 py-2">{row.email}</td>
                  <td className="px-2 py-2">{row.planName ?? "—"}</td>
                  <td className="whitespace-nowrap px-2 py-2 font-semibold">{formatMoneyMinor(row.amountMinor, row.currency)}</td>
                  <td className="px-2 py-2 text-xs capitalize">
                    {row.status}
                    {row.failureReason && <span className="ml-1 text-slate-500">({row.failureReason.slice(0, 40)})</span>}
                  </td>
                  <td className="px-2 py-2 text-xs text-slate-500">{row.reference ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function PlansPanel() {
  const [plans, setPlans] = useState<PlanDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Partial<PlanDTO>>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await getJson<{ plans: PlanDTO[] }>("/api/admin/plans");
    setPlans(data.plans ?? []);
    setDrafts({});
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const update = (id: string, patch: Partial<PlanDTO>) => {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  };

  const save = async (plan: PlanDTO) => {
    const draft = drafts[plan.id];
    if (!draft) return;
    const { ok, data } = await mutate<{ message?: string }>("/api/admin/plans", "PATCH", { id: plan.id, ...draft });
    setMessage(ok ? (data.message ?? "Plan saved.") : null);
    setError(ok ? null : (data.error ?? "Could not save the plan."));
    if (ok) await load();
  };

  if (loading) return <Loading label="Loading plans" />;

  return (
    <div className="space-y-4">
      {message && <Notice tone="success">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <Notice>
        Prices are stored in minor units (paisa/cents) and appear on the pricing page immediately. Recurring billing
        requires a Safepay plan id issued for this merchant account; keep one-time billing until Safepay approves
        recurring charging.
      </Notice>
      {plans.map((plan) => {
        const draft = { ...plan, ...drafts[plan.id] };
        return (
          <Card key={plan.id} title={`${plan.name} (${plan.id})`}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className={labelCls}>Name</label>
                <input className={inputCls} value={draft.name} onChange={(event) => update(plan.id, { name: event.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Price (minor units)</label>
                <input
                  className={inputCls}
                  type="number"
                  min={0}
                  value={draft.priceMinor}
                  onChange={(event) => update(plan.id, { priceMinor: Number(event.target.value) })}
                />
              </div>
              <div>
                <label className={labelCls}>Compare-at (optional)</label>
                <input
                  className={inputCls}
                  type="number"
                  min={0}
                  value={draft.compareAtMinor ?? ""}
                  onChange={(event) =>
                    update(plan.id, { compareAtMinor: event.target.value === "" ? null : Number(event.target.value) })
                  }
                />
              </div>
              <div>
                <label className={labelCls}>Currency</label>
                <select className={inputCls} value={draft.currency} onChange={(event) => update(plan.id, { currency: event.target.value })}>
                  {["PKR", "USD", "AED", "SAR", "GBP", "EUR"].map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Safepay plan id (recurring only)</label>
                <input
                  className={inputCls}
                  placeholder="plan_…"
                  value={draft.providerPlanId ?? ""}
                  onChange={(event) => update(plan.id, { providerPlanId: event.target.value || null })}
                />
              </div>
              <div>
                <label className={labelCls}>Billing mode</label>
                <select
                  className={inputCls}
                  value={draft.billingMode}
                  onChange={(event) => update(plan.id, { billingMode: event.target.value as "one_time" | "recurring" })}
                >
                  <option value="one_time">One-time payment</option>
                  <option value="recurring">Recurring subscription</option>
                </select>
              </div>
              <div className="flex items-end gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.active}
                    onChange={(event) => update(plan.id, { active: event.target.checked })}
                  />
                  Published
                </label>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Displays as {formatMoneyMinor(draft.priceMinor, draft.currency)} / {plan.interval}
              </p>
              <Button variant="primary" size="sm" onClick={() => void save(plan)} disabled={!drafts[plan.id]}>
                Save plan
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SettingsPanel() {
  const [billing, setBilling] = useState<BillingSettings | null>(null);
  const [adsense, setAdsense] = useState<AdsenseSettings | null>(null);
  const [storage, setStorage] = useState<StorageSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { data } = await getJson<{ billing: BillingSettings; adsense: AdsenseSettings; storage: StorageSettings }>("/api/admin/settings");
      setBilling(data.billing ?? null);
      setAdsense(data.adsense ?? null);
      setStorage(data.storage ?? null);
      setLoading(false);
    })();
  }, []);

  const save = async () => {
    if (!billing || !adsense || !storage) return;
    const { ok, data } = await mutate<{ message?: string }>("/api/admin/settings", "PATCH", { billing, adsense, storage });
    if (ok) {
      setMessage(data.message ?? "Settings saved.");
      setError(null);
    } else {
      setError(data.error ?? "Could not save settings.");
      setMessage(null);
    }
  };

  const setSlot = (placement: string, value: string) => {
    if (!adsense) return;
    setAdsense({ ...adsense, slots: { ...adsense.slots, [placement]: value } });
  };

  if (loading) return <Loading label="Loading settings" />;

  return (
    <div className="space-y-4">
      {message && <Notice tone="success">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <Card title="Google AdSense">
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
          Ads appear for Free accounts only. Leave this disabled until Google has approved the site and provided the
          publisher id and ad unit ids; with no publisher id nothing is rendered at all.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Publisher id</label>
            <input
              className={inputCls}
              placeholder="ca-pub-1234567890123456"
              value={adsense?.publisherId ?? ""}
              onChange={(event) => adsense && setAdsense({ ...adsense, publisherId: event.target.value })}
            />
          </div>
          <div className="flex items-end gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={adsense?.enabled ?? false}
                disabled={!adsense?.publisherId}
                onChange={(event) => adsense && setAdsense({ ...adsense, enabled: event.target.checked })}
              />
              Ads enabled
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={adsense?.requireConsent ?? true}
                onChange={(event) => adsense && setAdsense({ ...adsense, requireConsent: event.target.checked })}
              />
              Require consent
            </label>
          </div>
          {["dashboard", "cloud", "tools", "pricing"].map((placement) => (
            <div key={placement}>
              <label className={labelCls}>Ad slot · {placement}</label>
              <input
                className={inputCls}
                placeholder="1234567890"
                value={adsense?.slots?.[placement] ?? ""}
                onChange={(event) => setSlot(placement, event.target.value)}
              />
            </div>
          ))}
        </div>
      </Card>

      <Card title="Billing">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className={labelCls}>Grace period (days)</label>
            <input
              className={inputCls}
              type="number"
              min={0}
              max={60}
              value={billing?.graceDays ?? 3}
              onChange={(event) => billing && setBilling({ ...billing, graceDays: Number(event.target.value) })}
            />
          </div>
          <div>
            <label className={labelCls}>Support email shown to users</label>
            <input
              className={inputCls}
              value={billing?.supportEmail ?? ""}
              onChange={(event) => billing && setBilling({ ...billing, supportEmail: event.target.value })}
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={billing?.paused ?? false}
                onChange={(event) => billing && setBilling({ ...billing, paused: event.target.checked })}
              />
              Pause new checkouts
            </label>
          </div>
        </div>
      </Card>

      <Card title="Storage">
        <div className="max-w-xs">
          <label className={labelCls}>Maximum upload size (bytes)</label>
          <input
            className={inputCls}
            type="number"
            min={1024}
            max={524288000}
            value={storage?.maxUploadBytes ?? 52428800}
            onChange={(event) => storage && setStorage({ maxUploadBytes: Number(event.target.value) })}
          />
          <p className="mt-1 text-xs text-slate-500">Currently {formatBytes(storage?.maxUploadBytes ?? 0)} per file.</p>
        </div>
      </Card>

      <Button variant="primary" onClick={() => void save()}>
        Save settings
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function OpsPanel() {
  const [emails, setEmails] = useState<OutboxEmail[]>([]);
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [emailsResponse, eventsResponse] = await Promise.all([
      getJson<{ emails: OutboxEmail[] }>("/api/admin/outbox?limit=20"),
      getJson<{ events: WebhookEvent[] }>("/api/admin/webhooks?limit=20"),
    ]);
    setEmails(emailsResponse.data.emails ?? []);
    setEvents(eventsResponse.data.events ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const copyText = useMemo(() => (email: OutboxEmail) => `${email.subject}\n\n${email.body}`, []);

  if (loading) return <Loading label="Loading operations data" />;

  return (
    <div className="space-y-4">
      <Card
        title="Email outbox"
        icon={<Mail size={16} className="text-blue-600" aria-hidden />}
        actions={
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            <RefreshCw size={13} aria-hidden /> Refresh
          </Button>
        }
      >
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          Every transactional email is recorded here. When the transport is <code>console</code> (no SMTP/Resend
          configured) the verification or reset link is in the body — useful while finishing setup.
        </p>
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {emails.map((email) => (
            <li key={email.id} className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-800 dark:text-slate-100">{email.subject}</span>
                <span className="text-[11px] text-slate-500">
                  {email.to} · {email.kind} · {email.transport} · {email.status} ·{" "}
                  {new Date(email.createdAt).toLocaleString()}
                </span>
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-blue-700 dark:text-blue-300">Show message</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  {copyText(email)}
                </pre>
              </details>
            </li>
          ))}
          {emails.length === 0 && <li className="py-2 text-slate-500">No email has been sent yet.</li>}
        </ul>
      </Card>

      <Card title="Payment webhook deliveries" icon={<Webhook size={16} className="text-blue-600" aria-hidden />}>
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {events.map((event) => (
            <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="font-semibold text-slate-800 dark:text-slate-100">{event.eventType ?? "event"}</span>
              <span className="text-[11px] text-slate-500">
                {event.status} · signature {event.signatureValid ? "valid" : "invalid"} ·{" "}
                {new Date(event.receivedAt).toLocaleString()}
                {event.error ? ` · ${event.error}` : ""}
              </span>
            </li>
          ))}
          {events.length === 0 && <li className="py-2 text-slate-500">No webhook deliveries yet.</li>}
        </ul>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          Endpoint: <code>POST /api/payments/safepay/webhook</code> — signature is HMAC-SHA512 of the raw body with
          SAFEPAY_WEBHOOK_SECRET.
        </p>
      </Card>
    </div>
  );
}
