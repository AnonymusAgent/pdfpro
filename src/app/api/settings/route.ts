import { db } from "@/db";
import { settings } from "@/db/schema";

export const dynamic = "force-dynamic";

type Validator = (v: unknown) => boolean;

/** Only these keys can be persisted; anything else is rejected. */
const RULES: Record<string, Validator> = {
  theme: (v) => v === "light" || v === "dark",
  defaultZoom: (v) => typeof v === "number" && v >= 25 && v <= 400,
  defaultView: (v) => v === "continuous" || v === "single" || v === "two-page",
  maxFileMB: (v) => typeof v === "number" && v >= 1 && v <= 500,
  autosave: (v) => typeof v === "boolean",
  ocrLang: (v) => typeof v === "string" && /^[a-z]{3}(\+[a-z]{3}){0,3}$/.test(v),
};

export async function GET() {
  try {
    const rows = await db.select().from(settings);
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = r.value;
    return Response.json({ settings: out });
  } catch {
    return Response.json({ error: "Database unavailable." }, { status: 503 });
  }
}

export async function PUT(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const entries = Object.entries(body);
  const unknown = entries.map(([k]) => k).filter((k) => !(k in RULES));
  if (unknown.length) return Response.json({ error: `Unknown setting(s): ${unknown.join(", ")}` }, { status: 400 });
  const invalid = entries.filter(([k, v]) => !RULES[k](v)).map(([k]) => k);
  if (invalid.length) return Response.json({ error: `Invalid value for: ${invalid.join(", ")}` }, { status: 400 });
  try {
    for (const [key, value] of entries) {
      await db
        .insert(settings)
        .values({ key, value: value as never })
        .onConflictDoUpdate({ target: settings.key, set: { value: value as never, updatedAt: new Date() } });
    }
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Could not save settings." }, { status: 500 });
  }
}
