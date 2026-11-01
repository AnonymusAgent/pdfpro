import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { config } from "@/lib/server/config";
import { errorResponse } from "@/lib/server/api";
import { finalizePendingDeletions } from "@/lib/server/files";
import { syncSubscriptionLifecycle } from "@/lib/server/payments/billing";
import { pruneRateLimits } from "@/lib/server/rate-limit";
import { readSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Housekeeping: expire subscriptions, finish file deletions, prune counters.
 * Call every 15 minutes from a scheduler (cron, Vercel Cron, GitHub Action)
 * with `Authorization: Bearer $CRON_SECRET`. Administrators may also run it
 * from the admin dashboard.
 */
async function authorize(request: Request): Promise<boolean> {
  const secret = config.maintenance.cronSecret;
  const header = request.headers.get("authorization") ?? "";
  const provided = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : request.headers.get("x-cron-secret");
  if (secret && provided && provided === secret) return true;
  const session = await readSession();
  return Boolean(session?.user.isAdmin);
}

export async function POST(request: Request) {
  try {
    if (!(await authorize(request))) {
      return NextResponse.json({ error: "Not authorised." }, { status: 401 });
    }
    const lifecycle = await syncSubscriptionLifecycle();
    const deletions = await finalizePendingDeletions();
    await pruneRateLimits();
    await db.execute(sql`delete from payment_webhook_events where received_at < now() - interval '180 days'`);
    await db.execute(sql`delete from rate_limits where expires_at < now() - interval '2 days'`);

    return NextResponse.json({ ok: true, lifecycle, deletions, ranAt: new Date().toISOString() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST with Authorization: Bearer $CRON_SECRET to run maintenance." });
}
