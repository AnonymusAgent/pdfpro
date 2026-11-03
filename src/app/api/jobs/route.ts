import { withWorkspaceUser } from "@/lib/server/workspace-db";
import { jobs } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/lib/server/api";
import { requireSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = new Set(["completed", "failed", "cancelled"]);
const KIND = /^[a-z0-9-]{2,40}$/;

export async function GET() {
  try {
    const { user } = await requireSession();
    const rows = await withWorkspaceUser(user.id, (tx) => tx.select().from(jobs).where(eq(jobs.ownerUserId, user.id)).orderBy(desc(jobs.createdAt)).limit(50));
    return Response.json({ jobs: rows }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const { user } = await requireSession();
    const body = await readJson<Record<string, unknown>>(req);
    const kind = typeof body.kind === "string" ? body.kind : "";
    if (!KIND.test(kind)) throw new HttpError(400, "Invalid job kind.", "invalid_kind");
    const status = typeof body.status === "string" ? body.status : "completed";
    if (!STATUSES.has(status)) throw new HttpError(400, "Invalid status.", "invalid_status");
    const fileName = String(body.fileName ?? "file").split(/[\\/]/).pop()?.slice(0, 255) || "file";
    const inputSize = Math.max(0, Math.min(2 ** 31 - 1, Math.round(Number(body.inputSize) || 0)));
    const outputSize = Math.max(0, Math.min(2 ** 31 - 1, Math.round(Number(body.outputSize) || 0)));
    const message = typeof body.message === "string" ? body.message.slice(0, 300) : "";
    const [row] = await withWorkspaceUser(user.id, (tx) => tx.insert(jobs).values({ ownerUserId: user.id, kind, fileName, status, inputSize, outputSize, message }).returning());
    return Response.json({ job: row }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
