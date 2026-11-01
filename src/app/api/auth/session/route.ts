import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/server/api";
import { buildSessionPayload } from "@/lib/server/session-payload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await buildSessionPayload(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
