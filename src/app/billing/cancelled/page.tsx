import type { Metadata } from "next";
import { BillingReturnPanel } from "@/components/billing/billing-return";

export const metadata: Metadata = { title: "Checkout cancelled" };
export const dynamic = "force-dynamic";

export default async function BillingCancelledPage({
  searchParams,
}: {
  searchParams: Promise<{ payment?: string }>;
}) {
  const params = await searchParams;
  return <BillingReturnPanel paymentId={params.payment ?? ""} tracker={null} signature={null} cancelled />;
}
