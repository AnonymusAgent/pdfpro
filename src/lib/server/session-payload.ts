/** Shared shape of the session payload consumed by the browser. */
import type { SessionPayload } from "@/lib/session-types";
import { googleConfigured, safepayConfigured } from "./config";
import { getEntitlements } from "./entitlements";
import { listUserNotifications, listProviderStatus } from "./payments/billing";
import { readSession } from "./session";

export type { SessionPayload };

export async function buildSessionPayload(): Promise<SessionPayload> {
  const session = await readSession({ touch: true });
  const providers = listProviderStatus();
  const safepay = providers.find((provider) => provider.id === "safepay");
  const features = {
    googleSignIn: googleConfigured(),
    cardCheckout: Boolean(safepay?.configured) && safepayConfigured(),
    checkoutUnavailableReason:
      safepay?.unavailableReason ?? (safepayConfigured() ? null : "Card payments are not configured yet."),
  };

  if (!session) {
    return { user: null, entitlements: null, notifications: [], features };
  }

  const entitlements = await getEntitlements(session.user.id);
  const notifications = await listUserNotifications(session.user.id, 8).catch(() => []);
  return {
    user: { ...session.user, plan: entitlements.plan },
    entitlements,
    notifications,
    features,
  };
}
