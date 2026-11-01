import { NextResponse } from "next/server";
import { assertSameOrigin, errorResponse, readJson } from "@/lib/server/api";
import { listUserSessions, requireSession, revokeAllSessions, revokeSessionById } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireSession();
    return NextResponse.json({
      ok: true,
      sessions: await listUserSessions(session.user.id),
      currentSessionId: session.sessionId,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Revoke one session by id, or every other session when `all` is true. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    const body = await readJson<{ sessionId?: string; all?: boolean }>(request);
    if (body.all) {
      const count = await revokeAllSessions(session.user.id, session.sessionId);
      return NextResponse.json({ ok: true, revoked: count, message: `Signed out ${count} other session(s).` });
    }
    const sessionId = String(body.sessionId ?? "");
    if (!sessionId) return NextResponse.json({ error: "sessionId is required." }, { status: 400 });
    const revoked = await revokeSessionById(sessionId, session.user.id);
    if (!revoked) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    return NextResponse.json({ ok: true, revoked: 1 });
  } catch (error) {
    return errorResponse(error);
  }
}
