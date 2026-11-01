import { NextResponse } from "next/server";
import { assertSameOrigin, errorResponse, HttpError } from "@/lib/server/api";
import { getEntitlements } from "@/lib/server/entitlements";
import { listUserFiles, uploadPdfFile } from "@/lib/server/files";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { requireVerifiedSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireVerifiedSession();
    const params = new URL(request.url).searchParams;
    const sort = params.get("sort");
    const result = await listUserFiles(session.user.id, {
      q: params.get("q") ?? undefined,
      sort: sort === "name" || sort === "size" || sort === "created" ? sort : "created",
      order: params.get("order") === "asc" ? "asc" : "desc",
      limit: Number(params.get("limit") ?? 50),
      offset: Number(params.get("offset") ?? 0),
    });
    const entitlements = await getEntitlements(session.user.id);
    return NextResponse.json({ ok: true, ...result, storage: entitlements.storage, plan: entitlements.plan });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireVerifiedSession();
    await enforceRateLimit(`upload:${session.user.id}`, 30, 3600);

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      throw new HttpError(415, "Uploads must be sent as multipart/form-data.", "invalid_content_type");
    }

    const form = await request.formData();
    const entry = form.get("file");
    if (!entry || typeof entry === "string") throw new HttpError(400, "Attach a PDF file in the `file` field.", "file_missing");

    const nameField = form.get("name");
    const result = await uploadPdfFile({
      userId: session.user.id,
      file: entry,
      name: typeof nameField === "string" && nameField.trim() ? nameField : entry.name,
    });

    return NextResponse.json({ ok: true, file: result.file, storage: result.storage }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
