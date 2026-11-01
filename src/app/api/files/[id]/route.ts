import { NextResponse } from "next/server";
import { assertSameOrigin, errorResponse, readJson } from "@/lib/server/api";
import { deleteUserFile, getOwnedFile, renameUserFile } from "@/lib/server/files";
import { getEntitlements } from "@/lib/server/entitlements";
import { requireVerifiedSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const session = await requireVerifiedSession();
    const { id } = await params;
    const row = await getOwnedFile(session.user.id, id);
    return NextResponse.json({
      ok: true,
      file: {
        id: row.id,
        name: row.name,
        sizeBytes: Number(row.sizeBytes),
        createdAt: row.createdAt.toISOString(),
        checksumSha256: row.checksumSha256,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { id } = await params;
    const body = await readJson<{ name?: string }>(request);
    const file = await renameUserFile(session.user.id, id, String(body.name ?? ""));
    return NextResponse.json({ ok: true, file });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    const { id } = await params;
    const result = await deleteUserFile(session.user.id, id);
    const entitlements = await getEntitlements(session.user.id);
    return NextResponse.json({
      ok: true,
      reclaimedBytes: result.reclaimedBytes,
      storage: entitlements.storage,
      message: "File deleted and storage reclaimed.",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
