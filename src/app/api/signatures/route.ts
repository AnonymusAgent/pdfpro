import { db } from "@/db";
import { signatures } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/lib/server/api";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { workspaceScope } from "@/lib/server/workspace-scope";

export const dynamic = "force-dynamic";

const MAX_DATA_URL = 700_000;

/** Saved signature images are private to a user or an opaque guest workspace. */
export async function GET(request: Request) {
  try {
    const owner = await workspaceScope(request);
    const rows = await db.select().from(signatures).where(eq(signatures.workspaceId, owner)).orderBy(desc(signatures.createdAt)).limit(20);
    return Response.json({ signatures: rows });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const owner = await workspaceScope(request);
    await enforceRateLimit(`signature:${owner}`, 30, 3600);
    const body = await readJson<{ dataUrl?: unknown; name?: unknown; kind?: unknown }>(request, MAX_DATA_URL + 2048);
    const dataUrl = typeof body.dataUrl === "string" ? body.dataUrl : "";
    if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) throw new HttpError(400, "Signature must be a PNG or JPEG image.", "invalid_image");
    if (dataUrl.length > MAX_DATA_URL) throw new HttpError(413, "Signature image is too large.", "image_too_large");
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "Signature";
    const kind = body.kind === "type" || body.kind === "upload" ? body.kind : "draw";
    const [row] = await db.insert(signatures).values({ workspaceId: owner, name, dataUrl, kind }).returning();
    return Response.json({ signature: row }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const owner = await workspaceScope(request);
    const id = Number(new URL(request.url).searchParams.get("id"));
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "A valid id is required.", "invalid_id");
    const [deleted] = await db.delete(signatures).where(and(eq(signatures.id, id), eq(signatures.workspaceId, owner))).returning({ id: signatures.id });
    if (!deleted) throw new HttpError(404, "Signature not found.", "not_found");
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
