import type { Metadata } from "next";
import Link from "next/link";
import { Check, Crown, Sparkles, X } from "lucide-react";
import { AdSlot } from "@/components/ads/ad-slot";
import { PlanCheckoutButton } from "@/components/billing/plan-checkout";
import { PageTitle } from "@/components/ui";
import { formatMoneyMinor, FREE_STORAGE_BYTES, gigabytes, PREMIUM_STORAGE_BYTES } from "@/lib/plans";
import { getBillingSettings } from "@/lib/server/platform-settings";
import { listPlans, listProviderStatus, serializePlan } from "@/lib/server/payments/billing";
import { readSession } from "@/lib/server/session";
import { getEntitlements } from "@/lib/server/entitlements";

export const metadata: Metadata = {
  title: "Pricing — Free and Premium PDF storage",
  description: "Free PDF tools with 2 GB of private cloud storage. Premium adds 10 GB and removes all advertising.",
};

export const dynamic = "force-dynamic";

export default async function PricingPage() {
  const session = await readSession().catch(() => null);
  const plans = (await listPlans(false).catch(() => [])).map(serializePlan);
  const billing = await getBillingSettings().catch(() => null);
  const providers = listProviderStatus();
  const safepay = providers.find((provider) => provider.id === "safepay");
  const checkoutAvailable = Boolean(safepay?.configured) && !billing?.paused;
  const unavailableReason = billing?.paused
    ? "Checkout is temporarily paused by the administrator."
    : (safepay?.unavailableReason ?? "Card payments are not configured on this deployment yet.");

  const entitlements = session ? await getEntitlements(session.user.id).catch(() => null) : null;
  const isPremium = entitlements?.plan === "premium";

  const monthly = plans.find((plan) => plan.interval === "month");
  const yearly = plans.find((plan) => plan.interval === "year");
  const ordered = [monthly, yearly].filter(Boolean) as typeof plans;

  const comparison: { feature: string; free: string | boolean; premium: string | boolean }[] = [
    { feature: "Cloud storage", free: gigabytes(FREE_STORAGE_BYTES), premium: gigabytes(PREMIUM_STORAGE_BYTES) },
    { feature: "PDF uploads to cloud", free: true, premium: true },
    { feature: "File preview", free: true, premium: true },
    { feature: "File downloads", free: true, premium: true },
    { feature: "Cloud file manager", free: true, premium: true },
    { feature: "Advertisements", free: "Yes", premium: "None" },
    { feature: "Premium badge", free: false, premium: true },
    { feature: "Premium dashboard", free: false, premium: true },
    { feature: "Subscription & billing management", free: false, premium: true },
    { feature: "All browser PDF tools (edit, convert, OCR, sign)", free: true, premium: true },
  ];

  return (
    <div className="mx-auto w-full max-w-7xl space-y-10 px-4 py-8">
      <PageTitle
        title="Simple pricing"
        description={
          <span>
            Every tool stays free. Cloud storage, an ad-free workspace and premium support are what Premium adds. Prices
            below are read live from the administrator&apos;s plan settings.
          </span>
        }
        actions={
          isPremium ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1.5 text-sm font-bold text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
              <Crown size={15} aria-hidden /> You are on Premium
            </span>
          ) : undefined
        }
      />

      <section className="grid gap-5 md:grid-cols-2">
        <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">Free</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Everything you need to work on PDFs.</p>
          <p className="mt-4 text-4xl font-black text-slate-900 dark:text-slate-50">
            {formatMoneyMinor(0, monthly?.currency ?? "PKR")}
            <span className="text-base font-semibold text-slate-500"> / forever</span>
          </p>
          <ul className="mt-5 space-y-2 text-sm text-slate-700 dark:text-slate-300">
            {[
              `${gigabytes(FREE_STORAGE_BYTES)} private cloud storage`,
              "All browser PDF tools",
              "File preview, download and management",
              "Access from any device",
              "Advertisements shown",
            ].map((item) => (
              <li key={item} className="flex gap-2">
                <Check size={16} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <div className="mt-6">
            {isPremium ? (
              <p className="rounded-lg bg-slate-100 px-3 py-2 text-center text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                Your Premium plan includes everything in Free.
              </p>
            ) : session ? (
              <Link
                href="/dashboard"
                className="flex w-full items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
              >
                Go to my dashboard
              </Link>
            ) : (
              <Link
                href="/register"
                className="flex w-full items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
              >
                Create a free account
              </Link>
            )}
          </div>
        </article>

        {ordered.map((plan) => {
          const perMonth = plan.interval === "year" ? Math.round(plan.priceMinor / 12) : plan.priceMinor;
          const savings =
            plan.compareAtMinor && plan.compareAtMinor > plan.priceMinor
              ? Math.round(((plan.compareAtMinor - plan.priceMinor) / plan.compareAtMinor) * 100)
              : null;
          return (
            <article
              key={plan.id}
              className="relative rounded-2xl border-2 border-blue-600 bg-white p-6 shadow-lg dark:border-blue-500 dark:bg-slate-900"
            >
              <span className="absolute -top-3 left-6 inline-flex items-center gap-1 rounded-full bg-blue-600 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-white">
                <Crown size={12} aria-hidden /> {plan.name}
              </span>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{plan.description}</p>
              <p className="mt-4 flex items-end gap-2">
                <span className="text-4xl font-black text-slate-900 dark:text-slate-50">
                  {formatMoneyMinor(plan.priceMinor, plan.currency)}
                </span>
                <span className="pb-1 text-sm font-semibold text-slate-500 dark:text-slate-400">
                  / {plan.interval === "year" ? "year" : "month"}
                </span>
              </p>
              {savings !== null && (
                <p className="mt-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                  Save {savings}% compared with {formatMoneyMinor(plan.compareAtMinor!, plan.currency)}
                </p>
              )}
              {plan.interval === "year" && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Equivalent to {formatMoneyMinor(perMonth, plan.currency)} per month.
                </p>
              )}
              <ul className="mt-5 space-y-2 text-sm text-slate-700 dark:text-slate-300">
                {(plan.features.length ? plan.features : ["10 GB cloud storage", "Completely ad-free", "Premium badge"]).map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <Sparkles size={15} className="mt-0.5 shrink-0 text-blue-600" aria-hidden />
                    <span>{feature}</span>
                  </li>
                ))}
                <li className="flex gap-2">
                  <Check size={16} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden />
                  <span>{plan.billingMode === "recurring" ? "Renews automatically until cancelled" : "One payment for this term"}</span>
                </li>
              </ul>
              <div className="mt-6">
                {isPremium ? (
                  <Link
                    href="/account?tab=billing"
                    className="flex w-full items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  >
                    Manage my subscription
                  </Link>
                ) : (
                  <PlanCheckoutButton
                    planId={plan.id}
                    planName={plan.name}
                    label={`Subscribe — ${formatMoneyMinor(plan.priceMinor, plan.currency)} / ${plan.interval}`}
                    available={checkoutAvailable}
                    unavailableReason={unavailableReason}
                    signedIn={Boolean(session)}
                    emailVerified={Boolean(session?.user.emailVerified)}
                  />
                )}
              </div>
            </article>
          );
        })}
        {ordered.length === 0 && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            No Premium plans are published yet. An administrator can add them in the admin dashboard.
          </p>
        )}
      </section>

      <AdSlot placement="pricing" className="mx-auto max-w-3xl" />

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <h2 className="border-b border-slate-100 p-5 text-lg font-bold dark:border-slate-800">Free vs Premium</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                <th className="px-5 py-3 font-semibold">Feature</th>
                <th className="px-5 py-3 font-semibold">Free</th>
                <th className="px-5 py-3 font-semibold text-blue-700 dark:text-blue-300">Premium</th>
              </tr>
            </thead>
            <tbody>
              {comparison.map((row) => (
                <tr key={row.feature} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-5 py-3 text-slate-800 dark:text-slate-200">{row.feature}</td>
                  <td className="px-5 py-3 text-slate-600 dark:text-slate-400">
                    <Cell value={row.free} />
                  </td>
                  <td className="px-5 py-3 font-semibold text-slate-800 dark:text-slate-200">
                    <Cell value={row.premium} premium />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {[
          {
            title: "Cancel whenever you like",
            body: "Cancelling stops future charges. Premium benefits continue to the end of the paid term, then the account returns to Free.",
          },
          {
            title: "Files are never deleted",
            body: "If a plan ends while you are over the Free limit, your files stay. Uploads pause until you free space or upgrade again.",
          },
          {
            title: "Secure Pakistani checkout",
            body: "Safepay hosts the payment page and handles card tokenisation; PDF Pro only stores the transaction reference. Server-side verification decides when Premium starts.",
          },
        ].map((card) => (
          <article key={card.title} className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">{card.title}</h3>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{card.body}</p>
          </article>
        ))}
      </section>

      <p className="text-center text-xs text-slate-500 dark:text-slate-400">
        Questions about billing? <Link href="/help" className="font-semibold underline">Read the billing help</Link>
        {billing?.supportEmail ? <> or email {billing.supportEmail}</> : null}.
      </p>
    </div>
  );
}

function Cell({ value, premium = false }: { value: string | boolean; premium?: boolean }) {
  if (value === true) return <Check size={16} className={premium ? "text-emerald-600" : "text-emerald-600"} aria-label="Included" />;
  if (value === false) return <X size={16} className="text-slate-400" aria-label="Not included" />;
  return <span>{value}</span>;
}
