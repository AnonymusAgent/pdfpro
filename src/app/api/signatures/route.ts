import { db } from "@/db";
import { signatures } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const MAX_DATA_URL = 700_000;

/** Saved signature images. Stored only when the user explicitly clicks "Save signature". */
export async function GET() {
  try {
    const rows = await db.select().from(signatures).orderBy(desc(signatures.createdAt)).limit(20);
    return Response.json({ signatures: rows });
  } catch {
    return Response.json({ error: "Database unavailable." }, { status: 503 });
  }
}

export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const dataUrl = typeof b.dataUrl === "string" ? b.dataUrl : "";
  if (!/^data:image\/(png|jpeg);base64,/.test(dataUrl)) return Response.json({ error: "Signature must be a PNG or JPEG image." }, { status: 400 });
  if (dataUrl.length > MAX_DATA_URL) return Response.json({ error: "Signature image is too large." }, { status: 413 });
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 80) : "Signature";
  const kind = b.kind === "type" || b.kind === "upload" ? b.kind : "draw";
  try {
    const [row] = await db.insert(signatures).values({ name, dataUrl, kind }).returning();
    return Response.json({ signature: row }, { status: 201 });
  } catch {
    return Response.json({ error: "Could not save the signature." }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "A valid id is required." }, { status: 400 });
  try {
    await db.delete(signatures).where(eq(signatures.id, id));
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Could not delete the signature." }, { status: 500 });
  }
}
