import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { errorResponse } from "@/lib/server/api";
import { storageTotals } from "@/lib/server/files";
import { requireAdmin } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdmin();
    const [counts, revenue, storage] = await Promise.all([
      db.execute<{
        total_users: number;
        free_users: number;
        premium_users: number;
        active_subs: number;
        past_due_subs: number;
        verified_users: number;
        new_users_30d: number;
      }>(sql`
        select
          (select count(*)::int from users) as total_users,
          (select count(*)::int from users where plan = 'free') as free_users,
          (select count(*)::int from users where plan = 'premium') as premium_users,
          (select count(*)::int from subscriptions where status = 'active' and (current_period_end is null or current_period_end > now())) as active_subs,
          (select count(*)::int from subscriptions where status = 'past_due') as past_due_subs,
          (select count(*)::int from users where email_verified_at is not null) as verified_users,
          (select count(*)::int from users where created_at > now() - interval '30 days') as new_users_30d
      `),
      db.execute<{
        currency: string;
        mrr_minor: string;
        annual_plan_minor: string;
        succeeded_payments: number;
        failed_payments: number;
        total_payments: number;
        revenue_30d_minor: string;
        total_revenue_minor: string;
      }>(sql`
        with currency_set as (
          select distinct currency from payments
        )
        select
          c.currency,
          coalesce((
            select sum(case when pl.interval = 'year' then round(pl.price_minor::numeric / 12) else pl.price_minor end)
            from subscriptions s
            join subscription_plans pl on pl.id = s.plan_id
            where s.status in ('active', 'past_due')
              and (s.current_period_end is null or s.current_period_end > now())
              and pl.currency = c.currency
          ), 0)::bigint as mrr_minor,
          coalesce((
            select sum(pl.price_minor)
            from subscriptions s
            join subscription_plans pl on pl.id = s.plan_id
            where s.status in ('active', 'past_due') and pl.interval = 'year' and pl.currency = c.currency
              and (s.current_period_end is null or s.current_period_end > now())
          ), 0)::bigint as annual_plan_minor,
          (select count(*)::int from payments pm where pm.status = 'succeeded' and pm.currency = c.currency) as succeeded_payments,
          (select count(*)::int from payments pm where pm.status = 'failed' and pm.currency = c.currency) as failed_payments,
          (select count(*)::int from payments pm where pm.currency = c.currency) as total_payments,
          coalesce((select sum(pm.amount_minor) from payments pm where pm.status = 'succeeded' and pm.currency = c.currency and pm.created_at > now() - interval '30 days'), 0)::bigint as revenue_30d_minor,
          coalesce((select sum(pm.amount_minor) from payments pm where pm.status = 'succeeded' and pm.currency = c.currency), 0)::bigint as total_revenue_minor
        from currency_set c
      `),
      storageTotals(),
    ]);

    const row = counts.rows[0] ?? {
      total_users: 0,
      free_users: 0,
      premium_users: 0,
      active_subs: 0,
      past_due_subs: 0,
      verified_users: 0,
      new_users_30d: 0,
    };

    const revenueRows = revenue.rows.map((r) => ({
      currency: r.currency,
      mrrMinor: Number(r.mrr_minor),
      annualPlanMinor: Number(r.annual_plan_minor),
      succeededPayments: Number(r.succeeded_payments),
      failedPayments: Number(r.failed_payments),
      totalPayments: Number(r.total_payments),
      revenue30dMinor: Number(r.revenue_30d_minor),
      totalRevenueMinor: Number(r.total_revenue_minor),
    }));

    const [webhooks] = (
      await db.execute<{ total: number; failed: number; last24h: number }>(sql`
        select
          count(*)::int as total,
          count(*) filter (where status in ('error'))::int as failed,
          count(*) filter (where received_at > now() - interval '24 hours')::int as last24h
        from payment_webhook_events
      `)
    ).rows;

    return NextResponse.json({
      ok: true,
      users: {
        total: Number(row.total_users),
        free: Number(row.free_users),
        premium: Number(row.premium_users),
        verified: Number(row.verified_users),
        newLast30Days: Number(row.new_users_30d),
      },
      subscriptions: { active: Number(row.active_subs), pastDue: Number(row.past_due_subs) },
      revenue: revenueRows,
      payments: {
        succeeded: revenueRows.reduce((sum, r) => sum + r.succeededPayments, 0),
        failed: revenueRows.reduce((sum, r) => sum + r.failedPayments, 0),
        total: revenueRows.reduce((sum, r) => sum + r.totalPayments, 0),
      },
      storage,
      webhooks: {
        total: Number(webhooks?.total ?? 0),
        failed: Number(webhooks?.failed ?? 0),
        last24h: Number(webhooks?.last24h ?? 0),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
