import { withWorkspaceUser } from "@/lib/server/workspace-db";
import { signatures } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/lib/server/api";
import { requireSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DATA_URL = 700_000;

/** Saved signatures are sensitive: neither anonymous callers nor other users can read them. */
export async function GET() {
  try {
    const { user } = await requireSession();
    const rows = await withWorkspaceUser(user.id, (tx) => tx.select().from(signatures).where(eq(signatures.ownerUserId, user.id)).orderBy(desc(signatures.createdAt)).limit(20));
    return Response.json({ signatures: rows }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const { user } = await requireSession();
    const body = await readJson<Record<string, unknown>>(req, MAX_DATA_URL + 1024);
    const dataUrl = typeof body.dataUrl === "string" ? body.dataUrl : "";
    if (!/^data:image\/(png|jpeg);base64,/.test(dataUrl)) throw new HttpError(400, "Signature must be a PNG or JPEG image.", "invalid_signature");
    if (dataUrl.length > MAX_DATA_URL) throw new HttpError(413, "Signature image is too large.", "signature_too_large");
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "Signature";
    const kind = body.kind === "type" || body.kind === "upload" ? body.kind : "draw";
    const [row] = await withWorkspaceUser(user.id, (tx) => tx.insert(signatures).values({ ownerUserId: user.id, name, dataUrl, kind }).returning());
    return Response.json({ signature: row }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(req: Request) {
  try {
    assertSameOrigin(req);
    const { user } = await requireSession();
    const id = Number(new URL(req.url).searchParams.get("id"));
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "A valid id is required.", "invalid_id");
    const [removed] = await withWorkspaceUser(user.id, (tx) => tx.delete(signatures).where(and(eq(signatures.id, id), eq(signatures.ownerUserId, user.id))).returning({ id: signatures.id }));
    if (!removed) throw new HttpError(404, "Signature not found.", "not_found");
    return Response.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
