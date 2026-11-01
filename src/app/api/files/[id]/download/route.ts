import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { userFiles } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/server/api";
import { readFileStream, verifySignedFileToken } from "@/lib/server/files";
import { readSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streams a private file.
 *
 * Authorisation happens here and nowhere else: the caller must either hold a
 * valid session for the owning account, or present a signed URL that was issued
 * to that account for this exact file and has not expired.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    const disposition = url.searchParams.get("disposition") === "attachment" ? "attachment" : "inline";

    let authorizedUserId: string | null = null;
    if (token) {
      const verified = verifySignedFileToken(token, id);
      if (!verified) throw new HttpError(403, "This download link has expired. Refresh the page to get a new one.", "invalid_token");
      authorizedUserId = verified.userId;
    } else {
      const session = await readSession({ touch: true });
      if (!session) throw new HttpError(401, "Please sign in to download this file.", "unauthenticated");
      if (!session.user.emailVerified) throw new HttpError(403, "Verify your email to download files.", "email_unverified");
      authorizedUserId = session.user.id;
    }

    const [row] = await db
      .select()
      .from(userFiles)
      .where(and(eq(userFiles.id, id), eq(userFiles.userId, authorizedUserId), eq(userFiles.status, "active")))
      .limit(1);
    if (!row) throw new HttpError(404, "File not found.", "not_found");

    const { stream } = await readFileStream(row.id);
    const safeName = row.name.replace(/["\\\r\n]/g, "");
    return new NextResponse(stream as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(row.sizeBytes),
        "Content-Disposition": `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
