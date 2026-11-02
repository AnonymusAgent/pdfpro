import { HttpError, errorResponse } from "@/lib/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Account creation is exclusively available to signed-in administrators. */
export async function POST() {
  return errorResponse(new HttpError(403, "Accounts are created by an administrator. Please contact your administrator for access.", "registration_closed"));
}
