import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { errorResponse, HttpError, readJson, assertSameOrigin } from "@/lib/server/api";
import { requireAdmin } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const params = new URL(request.url).searchParams;
    const q = (params.get("q") ?? "").trim().slice(0, 120);
    const limit = Math.min(100, Math.max(1, Number(params.get("limit") ?? 25)));
    const offset = Math.max(0, Number(params.get("offset") ?? 0));
    const like = `%${q.toLowerCase()}%`;

    const rows = await db.execute<{
      id: string;
      email: string;
      display_name: string | null;
      plan: string;
      account_status: string;
      email_verified_at: string | null;
      created_at: string;
      last_login_at: string | null;
      used_bytes: string | null;
      file_count: number | null;
      role: string | null;
      subscription_status: string | null;
      subscription_plan: string | null;
      period_end: string | null;
    }>(sql`
      select u.id, u.email, u.display_name, u.plan, u.account_status, u.email_verified_at, u.created_at, u.last_login_at,
             su.used_bytes, su.file_count, ar.role,
             s.status as subscription_status, pl.name as subscription_plan, s.current_period_end as period_end
      from users u
      left join storage_usage su on su.user_id = u.id
      left join admin_roles ar on ar.user_id = u.id
      left join lateral (
        select ss.status, ss.plan_id, ss.current_period_end
        from subscriptions ss
        where ss.user_id = u.id
        order by ss.created_at desc
        limit 1
      ) s on true
      left join subscription_plans pl on pl.id = s.plan_id
      where (${q} = '' or u.email ilike ${like} or coalesce(u.display_name, '') ilike ${like})
      order by u.created_at desc
      limit ${limit} offset ${offset}
    `);

    const [total] = (
      await db.execute<{ count: number }>(sql`
        select count(*)::int as count from users u
        where (${q} = '' or u.email ilike ${like} or coalesce(u.display_name, '') ilike ${like})
      `)
    ).rows;

    return NextResponse.json({
      ok: true,
      total: Number(total?.count ?? 0),
      users: rows.rows.map((row) => ({
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        plan: row.plan,
        accountStatus: row.account_status,
        emailVerified: Boolean(row.email_verified_at),
        createdAt: new Date(row.created_at).toISOString(),
        lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
        usedBytes: Number(row.used_bytes ?? 0),
        fileCount: Number(row.file_count ?? 0),
        role: row.role,
        subscription: row.subscription_status
          ? { status: row.subscription_status, plan: row.subscription_plan, periodEnd: row.period_end ? new Date(row.period_end).toISOString() : null }
          : null,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Role and status operations. Access is re-checked server-side on every call. */
export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireAdmin();
    const body = await readJson<{ userId?: string; action?: string; value?: string }>(request);
    const userId = String(body.userId ?? "");
    const action = String(body.action ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new HttpError(400, "A valid userId is required.", "invalid_user");

    if (userId === actor.user.id && (action === "revoke_admin" || action === "suspend")) {
      throw new HttpError(400, "You cannot change your own administrator access or status.", "self_lockout");
    }

    switch (action) {
      case "grant_admin": {
        const role = body.value === "support" ? "support" : "admin";
        await db.execute(sql`
          insert into admin_roles (user_id, role, granted_by) values (${userId}, ${role}, ${actor.user.id})
          on conflict (user_id) do update set role = ${role}
        `);
        await db.execute(sql`
          insert into audit_log (actor_user_id, actor_email, action, target_type, target_id, metadata)
          values (${actor.user.id}, ${actor.user.email}, 'admin.grant', 'user', ${userId}, ${JSON.stringify({ role })}::jsonb)
        `);
        return NextResponse.json({ ok: true, message: "Administrator access granted." });
      }
      case "revoke_admin": {
        await db.execute(sql`delete from admin_roles where user_id = ${userId}`);
        await db.execute(sql`
          insert into audit_log (actor_user_id, actor_email, action, target_type, target_id)
          values (${actor.user.id}, ${actor.user.email}, 'admin.revoke', 'user', ${userId})
        `);
        return NextResponse.json({ ok: true, message: "Administrator access removed." });
      }
      case "suspend":
      case "activate": {
        const status = action === "suspend" ? "suspended" : "active";
        await db.execute(sql`update users set account_status = ${status}, updated_at = now() where id = ${userId}`);
        if (status === "suspended") await db.execute(sql`update sessions set revoked_at = now() where user_id = ${userId} and revoked_at is null`);
        await db.execute(sql`
          insert into audit_log (actor_user_id, actor_email, action, target_type, target_id, metadata)
          values (${actor.user.id}, ${actor.user.email}, ${`user.${action}`}, 'user', ${userId}, ${JSON.stringify({ status })}::jsonb)
        `);
        return NextResponse.json({ ok: true, message: status === "suspended" ? "Account suspended." : "Account reactivated." });
      }
      default:
        throw new HttpError(400, "Unknown action.", "unknown_action");
    }
  } catch (error) {
    return errorResponse(error);
  }
}
