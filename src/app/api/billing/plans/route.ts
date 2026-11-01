import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/server/api";
import { getBillingSettings } from "@/lib/server/platform-settings";
import { listPlans, listProviderStatus, serializePlan } from "@/lib/server/payments/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public plan catalogue. Prices are always read from the database. */
export async function GET() {
  try {
    const [plans, billing] = await Promise.all([listPlans(false), getBillingSettings()]);
    const providers = listProviderStatus();
    const safepay = providers.find((provider) => provider.id === "safepay");
    return NextResponse.json({
      ok: true,
      plans: plans.map(serializePlan),
      currency: plans[0]?.currency ?? "PKR",
      checkout: {
        available: Boolean(safepay?.configured) && !billing.paused,
        reason: billing.paused
          ? "Checkout is temporarily paused by the administrator."
          : (safepay?.unavailableReason ?? null),
        provider: "safepay",
      },
      billing: { graceDays: billing.graceDays, supportEmail: billing.supportEmail },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
