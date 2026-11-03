import { db } from "@/db";
import { workspaceSettings } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/lib/server/api";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { workspaceScope } from "@/lib/server/workspace-scope";

export const dynamic = "force-dynamic";

type Validator = (value: unknown) => boolean;

/** Only personal editor settings; global billing/AdSense/storage settings are separate. */
const RULES: Record<string, Validator> = {
  theme: (v) => v === "light" || v === "dark",
  defaultZoom: (v) => typeof v === "number" && Number.isFinite(v) && v >= 25 && v <= 400,
  defaultView: (v) => v === "continuous" || v === "single" || v === "two-page",
  maxFileMB: (v) => typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 500,
  autosave: (v) => typeof v === "boolean",
  ocrLang: (v) => typeof v === "string" && /^[a-z]{3}(\+[a-z]{3}){0,3}$/.test(v),
};

export async function GET(request: Request) {
  try {
    const owner = await workspaceScope(request);
    const rows = await db.select({ key: workspaceSettings.key, value: workspaceSettings.value }).from(workspaceSettings).where(eq(workspaceSettings.workspaceId, owner));
    const out: Record<string, unknown> = {};
    for (const row of rows) if (Object.hasOwn(RULES, row.key)) out[row.key] = row.value;
    return Response.json({ settings: out });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const owner = await workspaceScope(request);
    await enforceRateLimit(`workspace-settings:${owner}`, 120, 3600);
    const body = await readJson<Record<string, unknown>>(request);
    const entries = Object.entries(body);
    const unknown = entries.map(([key]) => key).filter((key) => !Object.hasOwn(RULES, key));
    if (unknown.length) throw new HttpError(400, `Unknown setting(s): ${unknown.join(", ")}`, "invalid_settings");
    const invalid = entries.filter(([key, value]) => !RULES[key]!(value)).map(([key]) => key);
    if (invalid.length) throw new HttpError(400, `Invalid value for: ${invalid.join(", ")}`, "invalid_settings");
    await db.transaction(async (tx) => {
      for (const [key, value] of entries) {
        await tx.insert(workspaceSettings).values({ workspaceId: owner, key, value: value as never })
          .onConflictDoUpdate({ target: [workspaceSettings.workspaceId, workspaceSettings.key], set: { value: value as never, updatedAt: new Date() } });
      }
    });
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
