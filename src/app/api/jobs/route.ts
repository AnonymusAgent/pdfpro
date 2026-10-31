import { db } from "@/db";
import { jobs } from "@/db/schema";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

const STATUSES = new Set(["completed", "failed", "cancelled"]);
const KIND = /^[a-z0-9-]{2,40}$/;

/** Processing log: operation name, file name (basename), sizes and a short status message. No content. */
export async function GET() {
  try {
    const rows = await db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(50);
    return Response.json({ jobs: rows });
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
  const kind = typeof b.kind === "string" ? b.kind : "";
  if (!KIND.test(kind)) return Response.json({ error: "Invalid job kind." }, { status: 400 });
  const status = typeof b.status === "string" ? b.status : "completed";
  if (!STATUSES.has(status)) return Response.json({ error: "Invalid status." }, { status: 400 });
  const fileName = String(b.fileName ?? "file").split(/[\\/]/).pop()?.slice(0, 255) || "file";
  const inputSize = Math.max(0, Math.min(2 ** 31 - 1, Math.round(Number(b.inputSize) || 0)));
  const outputSize = Math.max(0, Math.min(2 ** 31 - 1, Math.round(Number(b.outputSize) || 0)));
  const message = typeof b.message === "string" ? b.message.slice(0, 300) : "";
  try {
    const [row] = await db
      .insert(jobs)
      .values({ kind, fileName, status, inputSize, outputSize, message })
      .returning();
    return Response.json({ job: row }, { status: 201 });
  } catch {
    return Response.json({ error: "Could not record the job." }, { status: 500 });
  }
}
