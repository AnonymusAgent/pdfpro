import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { AccountWorkspace, type ProfileData } from "@/components/account/account-workspace";
import { PageTitle } from "@/components/ui";
import { getEntitlements } from "@/lib/server/entitlements";
import { listUserPayments } from "@/lib/server/payments/billing";
import { listUserSessions, readSession } from "@/lib/server/session";
import type { SessionUserPublic } from "@/lib/session-types";

export const metadata: Metadata = { title: "Account settings" };
export const dynamic = "force-dynamic";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await readSession().catch(() => null);
  if (!session) redirect("/login?next=/account");
  const { tab } = await searchParams;

  const [entitlements, profileRow, sessions, payments] = await Promise.all([
    getEntitlements(session.user.id),
    db.select().from(profiles).where(eq(profiles.userId, session.user.id)).limit(1),
    listUserSessions(session.user.id),
    listUserPayments(session.user.id, 50),
  ]);

  const profile: ProfileData | null = profileRow[0]
    ? {
        fullName: profileRow[0].fullName,
        company: profileRow[0].company,
        country: profileRow[0].country,
        timezone: profileRow[0].timezone,
        marketingOptIn: profileRow[0].marketingOptIn,
      }
    : null;

  const user: SessionUserPublic = { ...session.user, plan: entitlements.plan };
  const initialTab = tab === "billing" || tab === "devices" || tab === "security" ? tab : "profile";

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      <PageTitle title="Account settings" description="Profile, password, devices and billing for your PDF Pro account." />
      <AccountWorkspace
        user={user}
        entitlements={entitlements}
        profile={profile}
        sessions={sessions}
        payments={payments}
        initialTab={initialTab}
      />
    </div>
  );
}
