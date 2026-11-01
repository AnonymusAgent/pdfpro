import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { errorResponse } from "@/lib/server/api";
import { requireAdmin } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recent payment webhook deliveries, for reconciling provider disputes. */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const limit = Math.min(100, Math.max(1, Number(new URL(request.url).searchParams.get("limit") ?? 30)));
    const rows = await db.execute<{
      id: string;
      provider: string;
      event_id: string;
      event_type: string | null;
      signature_valid: boolean;
      status: string;
      error: string | null;
      received_at: string;
      processed_at: string | null;
    }>(sql`
      select id, provider, event_id, event_type, signature_valid, status, error, received_at, processed_at
      from payment_webhook_events
      order by received_at desc
      limit ${limit}
    `);
    return NextResponse.json({
      ok: true,
      events: rows.rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        eventId: row.event_id,
        eventType: row.event_type,
        signatureValid: row.signature_valid,
        status: row.status,
        error: row.error,
        receivedAt: new Date(row.received_at).toISOString(),
        processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : null,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
