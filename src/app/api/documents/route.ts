import { withWorkspaceUser } from "@/lib/server/workspace-db";
import { documents } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/lib/server/api";
import { requireSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = new Set(["pdf", "docx", "xlsx", "pptx", "image", "txt"]);
function parseId(v: string | null): number | null {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Workspace metadata is private to the current account. Guest history stays on-device. */
export async function GET() {
  try {
    const { user } = await requireSession();
    const rows = await withWorkspaceUser(user.id, (tx) => tx.select().from(documents).where(eq(documents.ownerUserId, user.id)).orderBy(desc(documents.updatedAt)).limit(100));
    return Response.json({ documents: rows }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const { user } = await requireSession();
    const body = await readJson<Record<string, unknown>>(req);
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 255) : "";
    const size = Number(body.size ?? 0);
    const pages = Number(body.pages ?? 0);
    const kind = typeof body.kind === "string" ? body.kind : "pdf";
    if (!name) throw new HttpError(400, "name is required.", "invalid_name");
    if (!Number.isInteger(size) || size < 0 || size > 2 ** 31 - 1) throw new HttpError(400, "size must be a non-negative integer.", "invalid_size");
    if (!Number.isInteger(pages) || pages < 0 || pages > 100000) throw new HttpError(400, "pages must be between 0 and 100000.", "invalid_pages");
    if (!KINDS.has(kind)) throw new HttpError(400, "Unsupported kind.", "invalid_kind");
    const [existing] = await withWorkspaceUser(user.id, (tx) => tx.select().from(documents).where(and(eq(documents.ownerUserId, user.id), eq(documents.name, name), eq(documents.size, size))).limit(1));
    if (existing) {
      const [row] = await withWorkspaceUser(user.id, (tx) => tx.update(documents).set({ pages, updatedAt: new Date() }).where(and(eq(documents.id, existing.id), eq(documents.ownerUserId, user.id))).returning());
      return Response.json({ document: row });
    }
    const [row] = await withWorkspaceUser(user.id, (tx) => tx.insert(documents).values({ ownerUserId: user.id, name, size, pages, kind }).returning());
    return Response.json({ document: row }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(req: Request) {
  try {
    assertSameOrigin(req);
    const { user } = await requireSession();
    const body = await readJson<Record<string, unknown>>(req);
    const id = parseId(String(body.id ?? ""));
    if (!id) throw new HttpError(400, "A valid id is required.", "invalid_id");
    const set: { starred?: boolean; name?: string } = {};
    if (typeof body.starred === "boolean") set.starred = body.starred;
    if (typeof body.name === "string" && body.name.trim()) set.name = body.name.trim().slice(0, 255);
    if (!Object.keys(set).length) throw new HttpError(400, "Nothing to update.", "invalid_update");
    const [row] = await withWorkspaceUser(user.id, (tx) => tx.update(documents).set(set).where(and(eq(documents.id, id), eq(documents.ownerUserId, user.id))).returning());
    if (!row) throw new HttpError(404, "Document record not found.", "not_found");
    return Response.json({ document: row });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(req: Request) {
  try {
    assertSameOrigin(req);
    const { user } = await requireSession();
    const id = parseId(new URL(req.url).searchParams.get("id"));
    if (!id) throw new HttpError(400, "A valid id is required.", "invalid_id");
    const [removed] = await withWorkspaceUser(user.id, (tx) => tx.delete(documents).where(and(eq(documents.id, id), eq(documents.ownerUserId, user.id))).returning({ id: documents.id }));
    if (!removed) throw new HttpError(404, "Document record not found.", "not_found");
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
