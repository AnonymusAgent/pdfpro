import { db } from "@/db";
import { settings } from "@/db/schema";
import { like } from "drizzle-orm";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/lib/server/api";
import { requireSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Validator = (v: unknown) => boolean;
const RULES: Record<string, Validator> = {
  theme: (v) => v === "light" || v === "dark",
  defaultZoom: (v) => typeof v === "number" && v >= 25 && v <= 400,
  defaultView: (v) => v === "continuous" || v === "single" || v === "two-page",
  maxFileMB: (v) => typeof v === "number" && v >= 1 && v <= 500,
  autosave: (v) => typeof v === "boolean",
  ocrLang: (v) => typeof v === "string" && /^[a-z]{3}(\+[a-z]{3}){0,3}$/.test(v),
};

/** Global billing, storage and AdSense keys never leave the admin API. */
export async function GET() {
  try {
    const { user } = await requireSession();
    const prefix = `user:${user.id}:pref:`;
    const rows = await db.select({ key: settings.key, value: settings.value }).from(settings).where(like(settings.key, `${prefix}%`));
    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.key.slice(prefix.length)] = row.value;
    return Response.json({ settings: out }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(req: Request) {
  try {
    assertSameOrigin(req);
    const { user } = await requireSession();
    const body = await readJson<Record<string, unknown>>(req);
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Settings must be an object.", "invalid_settings");
    const entries = Object.entries(body);
    const invalid = entries.filter(([key, value]) => !Object.hasOwn(RULES, key) || !RULES[key](value)).map(([key]) => key);
    if (invalid.length) throw new HttpError(400, `Invalid value for: ${invalid.join(", ")}`, "invalid_settings");
    await db.transaction(async (tx) => {
      for (const [key, value] of entries) {
        await tx.insert(settings).values({ key: `user:${user.id}:pref:${key}`, value: value as never })
          .onConflictDoUpdate({ target: settings.key, set: { value: value as never, updatedAt: new Date() } });
      }
    });
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
