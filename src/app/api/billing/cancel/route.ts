import { NextResponse } from "next/server";
import { assertSameOrigin, errorResponse, readJson } from "@/lib/server/api";
import { cancelUserSubscription } from "@/lib/server/payments/billing";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { requireSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireSession();
    await enforceRateLimit(`cancel:${session.user.id}`, 10, 3600);
    await readJson<Record<string, unknown>>(request);
    const result = await cancelUserSubscription({ userId: session.user.id, request });
    return NextResponse.json({
      ok: true,
      ...result,
      message:
        result.status === "cancelled_at_period_end"
          ? "Your subscription will not renew. Premium stays active until the end of the paid term."
          : "Your subscription has ended. Your files are safe on the Free plan.",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
