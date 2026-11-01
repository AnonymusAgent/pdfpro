/** In-app notifications plus an optional email copy. */
import { db } from "@/db";
import { userNotifications } from "@/db/schema";
import { notificationEmail } from "./auth-emails";
import type { EmailResult } from "./email";
import { sendEmail } from "./email";
import { resolveAppUrl } from "./config";

export async function notifyUser(params: {
  userId: string;
  kind: string;
  title: string;
  body: string;
  email?: string | null;
  displayName?: string | null;
  sendEmailCopy?: boolean;
  request?: Request;
}): Promise<{ emailResult?: EmailResult }> {
  await db.insert(userNotifications).values({
    userId: params.userId,
    kind: params.kind.slice(0, 64),
    title: params.title.slice(0, 200),
    body: params.body.slice(0, 2000),
  });

  if (params.sendEmailCopy !== false && params.email) {
    const template = notificationEmail({
      displayName: params.displayName ?? null,
      title: params.title,
      body: params.body,
      url: `${resolveAppUrl(params.request)}/dashboard`,
    });
    const result = await sendEmail({ to: params.email, kind: params.kind, ...template });
    return { emailResult: result };
  }
  return {};
}
