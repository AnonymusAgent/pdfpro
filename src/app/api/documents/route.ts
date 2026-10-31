import { db } from "@/db";
import { documents } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const KINDS = new Set(["pdf", "docx", "xlsx", "pptx", "image", "txt"]);

function fail(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function parseId(v: string | null): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Recent-document metadata only (name, size, page count). Document content is never stored. */
export async function GET() {
  try {
    const rows = await db.select().from(documents).orderBy(desc(documents.updatedAt)).limit(100);
    return Response.json({ documents: rows });
  } catch {
    return fail("Database unavailable.", 503);
  }
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("Request body must be JSON.");
  }
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 255) : "";
  const size = Number(body.size ?? 0);
  const pages = Number(body.pages ?? 0);
  const kind = typeof body.kind === "string" ? body.kind : "pdf";
  if (!name) return fail("name is required.");
  if (!Number.isInteger(size) || size < 0 || size > 2 ** 31 - 1) return fail("size must be a non-negative integer.");
  if (!Number.isInteger(pages) || pages < 0 || pages > 100000) return fail("pages must be an integer between 0 and 100000.");
  if (!KINDS.has(kind)) return fail("Unsupported kind.");
  try {
    const [existing] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.name, name), eq(documents.size, size)))
      .limit(1);
    if (existing) {
      const [row] = await db
        .update(documents)
        .set({ pages, updatedAt: new Date() })
        .where(eq(documents.id, existing.id))
        .returning();
      return Response.json({ document: row });
    }
    const [row] = await db.insert(documents).values({ name, size, pages, kind, starred: false }).returning();
    return Response.json({ document: row }, { status: 201 });
  } catch {
    return fail("Could not save the document record.", 500);
  }
}

export async function PATCH(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("Request body must be JSON.");
  }
  const id = parseId(String(body.id ?? ""));
  if (!id) return fail("A valid id is required.");
  const set: { starred?: boolean; name?: string } = {};
  if (typeof body.starred === "boolean") set.starred = body.starred;
  if (typeof body.name === "string" && body.name.trim()) set.name = body.name.trim().slice(0, 255);
  if (!Object.keys(set).length) return fail("Nothing to update.");
  try {
    const [row] = await db.update(documents).set(set).where(eq(documents.id, id)).returning();
    if (!row) return fail("Document record not found.", 404);
    return Response.json({ document: row });
  } catch {
    return fail("Could not update the document record.", 500);
  }
}

export async function DELETE(req: Request) {
  const id = parseId(new URL(req.url).searchParams.get("id"));
  if (!id) return fail("A valid id is required.");
  try {
    await db.delete(documents).where(eq(documents.id, id));
    return Response.json({ ok: true });
  } catch {
    return fail("Could not delete the document record.", 500);
  }
}
