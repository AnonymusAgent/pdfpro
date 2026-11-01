import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/server/api";
import { getAdsenseSettings, getBillingSettings } from "@/lib/server/platform-settings";
import { listPlans, listProviderStatus, serializePlan } from "@/lib/server/payments/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public configuration for the browser: plan catalogue, advertising settings and
 * which optional integrations are switched on. Contains no secrets — only the
 * AdSense publisher id and ad unit ids, which are public by design.
 */
export async function GET() {
  try {
    const [plans, adsense, billing] = await Promise.all([listPlans(false), getAdsenseSettings(), getBillingSettings()]);
    const providers = listProviderStatus();
    const safepay = providers.find((provider) => provider.id === "safepay");
    return NextResponse.json(
      {
        ok: true,
        plans: plans.map(serializePlan),
        ads: {
          enabled: adsense.enabled && Boolean(adsense.publisherId),
          publisherId: adsense.enabled ? adsense.publisherId : "",
          slots: adsense.enabled ? adsense.slots : {},
          requireConsent: adsense.requireConsent,
        },
        checkout: {
          available: Boolean(safepay?.configured) && !billing.paused,
          reason: billing.paused ? "Checkout is temporarily paused." : (safepay?.unavailableReason ?? null),
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
