import { db } from "@/db";
import { jobs } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/lib/server/api";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { workspaceScope } from "@/lib/server/workspace-scope";

export const dynamic = "force-dynamic";

const STATUSES = new Set(["completed", "failed", "cancelled"]);
const KIND = /^[a-z0-9-]{2,40}$/;

/** Processing metadata only (no document bytes), scoped to one workspace. */
export async function GET(request: Request) {
  try {
    const owner = await workspaceScope(request);
    const rows = await db.select().from(jobs).where(eq(jobs.workspaceId, owner)).orderBy(desc(jobs.createdAt)).limit(50);
    return Response.json({ jobs: rows });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const owner = await workspaceScope(request);
    await enforceRateLimit(`job:${owner}`, 300, 3600);
    const body = await readJson<{ kind?: unknown; status?: unknown; fileName?: unknown; inputSize?: unknown; outputSize?: unknown; message?: unknown }>(request);
    const kind = typeof body.kind === "string" ? body.kind : "";
    if (!KIND.test(kind)) throw new HttpError(400, "Invalid job kind.", "invalid_kind");
    const status = typeof body.status === "string" ? body.status : "completed";
    if (!STATUSES.has(status)) throw new HttpError(400, "Invalid status.", "invalid_status");
    const fileName = String(body.fileName ?? "file").split(/[\\/]/).pop()?.slice(0, 255) || "file";
    const inputSize = Math.max(0, Math.min(2 ** 31 - 1, Math.round(Number(body.inputSize) || 0)));
    const outputSize = Math.max(0, Math.min(2 ** 31 - 1, Math.round(Number(body.outputSize) || 0)));
    const message = typeof body.message === "string" ? body.message.slice(0, 300) : "";
    const [row] = await db.insert(jobs).values({ workspaceId: owner, kind, fileName, status, inputSize, outputSize, message }).returning();
    return Response.json({ job: row }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
