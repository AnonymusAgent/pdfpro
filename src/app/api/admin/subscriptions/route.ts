import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/lib/server/api";
import { cancelUserSubscription, syncSubscriptionLifecycle, verifyCheckoutReturn } from "@/lib/server/payments/billing";
import { requireAdmin } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const limit = Math.min(200, Math.max(1, Number(new URL(request.url).searchParams.get("limit") ?? 50)));
    const rows = await db.execute<{
      id: string;
      email: string;
      plan_name: string | null;
      status: string;
      billing_mode: string;
      provider: string;
      period_start: string | null;
      period_end: string | null;
      cancel_at_period_end: boolean;
      grace_until: string | null;
      created_at: string;
    }>(sql`
      select s.id, u.email, pl.name as plan_name, s.status, s.billing_mode, s.provider,
             s.current_period_start as period_start, s.current_period_end as period_end,
             s.cancel_at_period_end, s.grace_until, s.created_at
      from subscriptions s
      join users u on u.id = s.user_id
      left join subscription_plans pl on pl.id = s.plan_id
      order by s.created_at desc
      limit ${limit}
    `);
    return NextResponse.json({
      ok: true,
      subscriptions: rows.rows.map((row) => ({
        id: row.id,
        email: row.email,
        planName: row.plan_name,
        status: row.status,
        billingMode: row.billing_mode,
        provider: row.provider,
        periodStart: row.period_start ? new Date(row.period_start).toISOString() : null,
        periodEnd: row.period_end ? new Date(row.period_end).toISOString() : null,
        cancelAtPeriodEnd: row.cancel_at_period_end,
        graceUntil: row.grace_until ? new Date(row.grace_until).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Administrator actions: run the lifecycle job, or end a subscription now. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireAdmin();
    const body = await readJson<{ action?: string; userId?: string; paymentId?: string; tracker?: string }>(request);
    if (body.action === "sync") {
      const result = await syncSubscriptionLifecycle();
      await db.execute(sql`
        insert into audit_log (actor_user_id, actor_email, action, target_type, metadata)
        values (${actor.user.id}, ${actor.user.email}, 'lifecycle.run', 'system', ${JSON.stringify(result)}::jsonb)
      `);
      return NextResponse.json({ ok: true, result, message: "Lifecycle synchronised." });
    }
    if (body.action === "force_verify" && body.paymentId) {
      // Server-to-server verification against the provider (never trusts the
      // browser). The payment's owner scopes the lookup, exactly as it does for
      // the customer-facing endpoint.
      const [owner] = await db.execute<{ user_id: string }>(sql`
        select user_id from payments where id = ${String(body.paymentId)} limit 1
      `).then((result) => result.rows);
      if (!owner) return NextResponse.json({ ok: false, result: { status: "unknown", message: "Payment not found." } });
      const result = await verifyCheckoutReturn({
        paymentId: String(body.paymentId),
        userId: owner.user_id,
        tracker: body.tracker ? String(body.tracker) : null,
        signature: null,
        request,
      });
      return NextResponse.json({ ok: true, result });
    }
    if (body.action === "cancel_now" && body.userId) {
      const result = await cancelUserSubscription({ userId: String(body.userId), immediate: true, request });
      await db.execute(sql`
        insert into audit_log (actor_user_id, actor_email, action, target_type, target_id)
        values (${actor.user.id}, ${actor.user.email}, 'subscription.force_cancel', 'user', ${String(body.userId)})
      `);
      return NextResponse.json({ ok: true, result, message: "Subscription ended immediately." });
    }
    throw new HttpError(400, "Unknown action.", "unknown_action");
  } catch (error) {
    return errorResponse(error);
  }
}
