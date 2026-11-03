import { db } from "@/db";
import { documents } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/lib/server/api";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { workspaceScope } from "@/lib/server/workspace-scope";

export const dynamic = "force-dynamic";

const KINDS = new Set(["pdf", "docx", "xlsx", "pptx", "image", "txt"]);

function parseId(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, "A valid id is required.", "invalid_id");
  return n;
}

/** Recent-document metadata only; content remains in the browser. */
export async function GET(request: Request) {
  try {
    const owner = await workspaceScope(request);
    const rows = await db.select().from(documents).where(eq(documents.workspaceId, owner)).orderBy(desc(documents.updatedAt)).limit(100);
    return Response.json({ documents: rows });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const owner = await workspaceScope(request);
    await enforceRateLimit(`document:${owner}`, 300, 3600);
    const body = await readJson<{ name?: unknown; size?: unknown; pages?: unknown; kind?: unknown }>(request);
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 255) : "";
    const size = Number(body.size ?? 0);
    const pages = Number(body.pages ?? 0);
    const kind = typeof body.kind === "string" ? body.kind : "pdf";
    if (!name) throw new HttpError(400, "name is required.", "invalid_name");
    if (!Number.isInteger(size) || size < 0 || size > 2 ** 31 - 1) throw new HttpError(400, "size must be a non-negative integer.", "invalid_size");
    if (!Number.isInteger(pages) || pages < 0 || pages > 100000) throw new HttpError(400, "pages must be between 0 and 100000.", "invalid_pages");
    if (!KINDS.has(kind)) throw new HttpError(400, "Unsupported kind.", "invalid_kind");
    const [existing] = await db.select().from(documents).where(and(eq(documents.workspaceId, owner), eq(documents.name, name), eq(documents.size, size))).limit(1);
    if (existing) {
      const [row] = await db.update(documents).set({ pages, updatedAt: new Date() }).where(and(eq(documents.id, existing.id), eq(documents.workspaceId, owner))).returning();
      return Response.json({ document: row });
    }
    const [row] = await db.insert(documents).values({ workspaceId: owner, name, size, pages, kind, starred: false }).returning();
    return Response.json({ document: row }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const owner = await workspaceScope(request);
    const body = await readJson<{ id?: unknown; starred?: unknown; name?: unknown }>(request);
    const id = parseId(body.id);
    const set: { starred?: boolean; name?: string } = {};
    if (typeof body.starred === "boolean") set.starred = body.starred;
    if (typeof body.name === "string" && body.name.trim()) set.name = body.name.trim().slice(0, 255);
    if (!Object.keys(set).length) throw new HttpError(400, "Nothing to update.", "invalid_update");
    const [row] = await db.update(documents).set(set).where(and(eq(documents.id, id), eq(documents.workspaceId, owner))).returning();
    if (!row) throw new HttpError(404, "Document record not found.", "not_found");
    return Response.json({ document: row });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const owner = await workspaceScope(request);
    const id = parseId(new URL(request.url).searchParams.get("id"));
    const [deleted] = await db.delete(documents).where(and(eq(documents.id, id), eq(documents.workspaceId, owner))).returning({ id: documents.id });
    if (!deleted) throw new HttpError(404, "Document record not found.", "not_found");
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
