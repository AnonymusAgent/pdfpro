import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AdminDashboard } from "@/components/admin/admin-dashboard";
import { PageTitle } from "@/components/ui";
import { readSession } from "@/lib/server/session";

export const metadata: Metadata = { title: "Admin dashboard" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const session = await readSession().catch(() => null);
  if (!session) redirect("/login?next=/admin");
  // Server-side role check. Every /api/admin/* route repeats this check.
  if (!session.user.isAdmin) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-16">
        <div className="rounded-2xl border border-red-200 bg-white p-6 shadow-sm dark:border-red-900 dark:bg-slate-900">
          <h1 className="text-lg font-bold text-slate-900 dark:text-slate-50">Administrator access required</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            This dashboard is limited to accounts with an administrator role. If you believe you should have access, ask
            the operator to add your verified email address to <code>ADMIN_EMAILS</code> or run{" "}
            <code>npm run admin:grant -- you@example.com</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8">
      <PageTitle
        title="Admin dashboard"
        description="Users, subscriptions, revenue, pricing, advertising and payment operations — all server-authorised."
      />
      <AdminDashboard adminEmail={session.user.email} />
    </div>
  );
}
