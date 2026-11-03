import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { boundedInt, errorResponse } from "@/lib/server/api";
import { requireAdmin } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const params = new URL(request.url).searchParams;
    const status = params.get("status");
    const limit = boundedInt(Number(params.get("limit") ?? 50), 50, 1, 200);
    const allowed = ["pending", "succeeded", "failed", "refunded", "cancelled"];
    const filter = status && allowed.includes(status) ? status : "";

    const rows = await db.execute<{
      id: string;
      email: string;
      plan_name: string | null;
      amount_minor: number;
      currency: string;
      status: string;
      provider: string;
      provider_reference: string | null;
      failure_reason: string | null;
      created_at: string;
      paid_at: string | null;
    }>(sql`
      select p.id, u.email, pl.name as plan_name, p.amount_minor, p.currency, p.status, p.provider,
             p.provider_reference, p.failure_reason, p.created_at, p.paid_at
      from payments p
      join users u on u.id = p.user_id
      left join subscription_plans pl on pl.id = p.plan_id
      where (${filter} = '' or p.status = ${filter})
      order by p.created_at desc
      limit ${limit}
    `);

    return NextResponse.json({
      ok: true,
      payments: rows.rows.map((row) => ({
        id: row.id,
        email: row.email,
        planName: row.plan_name,
        amountMinor: Number(row.amount_minor),
        currency: row.currency,
        status: row.status,
        provider: row.provider,
        reference: row.provider_reference,
        failureReason: row.failure_reason,
        createdAt: new Date(row.created_at).toISOString(),
        paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
