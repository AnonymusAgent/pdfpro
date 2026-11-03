import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { boundedInt, errorResponse } from "@/lib/server/api";
import { requireAdmin } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Email outbox. When EMAIL_TRANSPORT is "console" (no SMTP/Resend configured)
 * verification and reset links land here, so an administrator can complete
 * setup before mail delivery is switched on.
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const limit = boundedInt(Number(new URL(request.url).searchParams.get("limit") ?? 30), 30, 1, 100);
    const rows = await db.execute<{
      id: string;
      to_email: string;
      subject: string;
      body_text: string;
      kind: string;
      transport: string;
      status: string;
      error: string | null;
      created_at: string;
    }>(sql`
      select id, to_email, subject, body_text, kind, transport, status, error, created_at
      from email_outbox
      order by created_at desc
      limit ${limit}
    `);
    return NextResponse.json({
      ok: true,
      emails: rows.rows.map((row) => ({
        id: row.id,
        to: row.to_email,
        subject: row.subject,
        body: row.body_text,
        kind: row.kind,
        transport: row.transport,
        status: row.status,
        error: row.error,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
