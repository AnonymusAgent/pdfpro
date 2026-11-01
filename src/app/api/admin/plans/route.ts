import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { subscriptionPlans } from "@/db/schema";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/lib/server/api";
import { listPlans, serializePlan } from "@/lib/server/payments/billing";
import { requireAdmin } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CURRENCIES = ["PKR", "USD", "AED", "SAR", "GBP", "EUR"];

export async function GET() {
  try {
    await requireAdmin();
    const plans = await listPlans(true);
    return NextResponse.json({ ok: true, plans: plans.map(serializePlan) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Administrators change prices, currency, discounts and availability here. */
export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireAdmin();
    const body = await readJson<{
      id?: string;
      name?: string;
      description?: string;
      priceMinor?: number;
      compareAtMinor?: number | null;
      currency?: string;
      active?: boolean;
      billingMode?: "one_time" | "recurring";
      providerPlanId?: string | null;
      features?: string[];
      sortOrder?: number;
    }>(request);

    const id = String(body.id ?? "");
    const [plan] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, id)).limit(1);
    if (!plan) throw new HttpError(404, "Plan not found.", "plan_not_found");

    const set: Partial<typeof subscriptionPlans.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) {
      const name = String(body.name).trim().slice(0, 120);
      if (!name) throw new HttpError(400, "Plan name cannot be empty.", "invalid_name");
      set.name = name;
    }
    if (body.description !== undefined) set.description = String(body.description).trim().slice(0, 400) || null;
    if (body.priceMinor !== undefined) {
      const price = Number(body.priceMinor);
      if (!Number.isInteger(price) || price < 0 || price > 100_000_000) {
        throw new HttpError(400, "Price must be an integer number of minor units (paisa).", "invalid_price");
      }
      set.priceMinor = price;
    }
    if (body.compareAtMinor !== undefined) {
      const compare = body.compareAtMinor === null ? null : Number(body.compareAtMinor);
      if (compare !== null && (!Number.isInteger(compare) || compare < 0 || compare > 100_000_000)) {
        throw new HttpError(400, "Compare-at price is invalid.", "invalid_price");
      }
      set.compareAtMinor = compare;
    }
    if (body.currency !== undefined) {
      const currency = String(body.currency).toUpperCase();
      if (!CURRENCIES.includes(currency)) {
        throw new HttpError(400, `Currency must be one of ${CURRENCIES.join(", ")}.`, "invalid_currency");
      }
      set.currency = currency;
    }
    if (body.active !== undefined) set.active = Boolean(body.active);
    if (body.billingMode !== undefined) {
      set.billingMode = body.billingMode === "recurring" ? "recurring" : "one_time";
    }
    if (body.providerPlanId !== undefined) {
      const providerPlanId = body.providerPlanId ? String(providerPlanIdClean(body.providerPlanId)) : null;
      if (providerPlanId && !/^plan_[A-Za-z0-9-]{4,64}$/.test(providerPlanId)) {
        throw new HttpError(400, "Safepay plan ids look like plan_xxxxxxxx-…", "invalid_plan_id");
      }
      set.providerPlanId = providerPlanId;
    }
    if (body.features !== undefined) {
      set.features = Array.isArray(body.features)
        ? body.features.map((f) => String(f).trim().slice(0, 120)).filter(Boolean).slice(0, 12)
        : [];
    }
    if (body.sortOrder !== undefined) set.sortOrder = Math.max(0, Math.min(999, Number(body.sortOrder) || 0));

    if (set.billingMode === "recurring" && !(set.providerPlanId ?? plan.providerPlanId)) {
      throw new HttpError(
        400,
        "Recurring billing needs a Safepay plan id. Leave the plan on one-time billing until Safepay issues one.",
        "missing_provider_plan",
      );
    }

    await db.update(subscriptionPlans).set(set).where(eq(subscriptionPlans.id, id));
    await db.execute(sql`
      insert into audit_log (actor_user_id, actor_email, action, target_type, target_id, metadata)
      values (${actor.user.id}, ${actor.user.email}, 'plan.update', 'subscription_plan', ${id}, ${JSON.stringify(set)}::jsonb)
    `);

    const [updated] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, id)).limit(1);
    return NextResponse.json({ ok: true, plan: serializePlan(updated!), message: "Plan updated." });
  } catch (error) {
    return errorResponse(error);
  }
}

function providerPlanIdClean(value: unknown): string {
  return String(value).trim().slice(0, 80);
}
