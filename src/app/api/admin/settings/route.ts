import { NextResponse } from "next/server";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/lib/server/api";
import {
  getAdsenseSettings,
  getBillingSettings,
  getStorageSettings,
  saveSetting,
  type AdsenseSettings,
  type BillingSettings,
  type StorageSettings,
} from "@/lib/server/platform-settings";
import { requireAdmin } from "@/lib/server/session";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdmin();
    const [billing, adsense, storage] = await Promise.all([
      getBillingSettings(),
      getAdsenseSettings(),
      getStorageSettings(),
    ]);
    return NextResponse.json({ ok: true, billing, adsense, storage });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireAdmin();
    const body = await readJson<{
      billing?: Partial<BillingSettings>;
      adsense?: Partial<AdsenseSettings>;
      storage?: Partial<StorageSettings>;
    }>(request);

    if (body.billing) {
      const current = await getBillingSettings();
      const graceDays = body.billing.graceDays === undefined ? current.graceDays : Number(body.billing.graceDays);
      if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 60) {
        throw new HttpError(400, "Grace period must be between 0 and 60 days.", "invalid_grace");
      }
      await saveSetting("billing", {
        ...current,
        graceDays,
        paused: body.billing.paused === undefined ? current.paused : Boolean(body.billing.paused),
        supportEmail: body.billing.supportEmail === undefined ? current.supportEmail : String(body.billing.supportEmail).slice(0, 200),
        prorationNote: body.billing.prorationNote === undefined ? current.prorationNote : String(body.billing.prorationNote).slice(0, 500),
      });
    }

    if (body.adsense) {
      const current = await getAdsenseSettings();
      const publisherId =
        body.adsense.publisherId === undefined ? current.publisherId : String(body.adsense.publisherId).trim();
      if (publisherId && !/^ca-pub-\d{10,20}$/.test(publisherId)) {
        throw new HttpError(400, "Publisher id must look like ca-pub-1234567890123456.", "invalid_publisher_id");
      }
      const slots: Record<string, string> = {};
      for (const [placement, slot] of Object.entries(body.adsense.slots ?? current.slots)) {
        if (!slot) continue;
        const value = String(slot).trim();
        if (!/^\d{3,30}$/.test(value)) {
          throw new HttpError(400, `Ad slot for "${placement}" must be numeric.`, "invalid_slot");
        }
        slots[placement] = value;
      }
      await saveSetting("adsense", {
        // Ads can only be enabled once a publisher id exists.
        enabled: publisherId ? Boolean(body.adsense.enabled ?? current.enabled) : false,
        publisherId,
        slots,
        requireConsent: body.adsense.requireConsent === undefined ? current.requireConsent : Boolean(body.adsense.requireConsent),
      } satisfies AdsenseSettings);
    }

    if (body.storage) {
      const current = await getStorageSettings();
      const maxUploadBytes = body.storage.maxUploadBytes === undefined ? current.maxUploadBytes : Number(body.storage.maxUploadBytes);
      if (!Number.isInteger(maxUploadBytes) || maxUploadBytes < 1024 || maxUploadBytes > 500 * 1024 * 1024) {
        throw new HttpError(400, "Maximum upload size must be between 1 KB and 500 MB.", "invalid_upload_limit");
      }
      await saveSetting("storage", { maxUploadBytes });
    }

    await db.execute(sql`
      insert into audit_log (actor_user_id, actor_email, action, target_type, metadata)
      values (${actor.user.id}, ${actor.user.email}, 'settings.update', 'settings', ${JSON.stringify(Object.keys(body))}::jsonb)
    `);

    const [billing, adsense, storage] = await Promise.all([getBillingSettings(), getAdsenseSettings(), getStorageSettings()]);
    return NextResponse.json({ ok: true, billing, adsense, storage, message: "Settings saved." });
  } catch (error) {
    return errorResponse(error);
  }
}
