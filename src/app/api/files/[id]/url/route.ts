import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/server/api";
import { getOwnedFile, signedDownloadUrl } from "@/lib/server/files";
import { requireVerifiedSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Issues a short-lived signed URL. The URL is bound to this file id and this
 * user id with an HMAC, so it cannot be replayed for another file or after it
 * expires.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireVerifiedSession();
    const { id } = await params;
    await getOwnedFile(session.user.id, id);
    return NextResponse.json({
      ok: true,
      url: signedDownloadUrl(id, session.user.id, { disposition: "inline" }),
      expiresInSeconds: 300,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
