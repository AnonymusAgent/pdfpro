import type { Metadata } from "next";
import { BillingReturnPanel } from "@/components/billing/billing-return";

export const metadata: Metadata = { title: "Confirming payment" };
export const dynamic = "force-dynamic";

export default async function BillingReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ payment?: string; tracker?: string; sig?: string; order_id?: string }>;
}) {
  const params = await searchParams;
  return (
    <BillingReturnPanel
      paymentId={params.payment ?? params.order_id ?? ""}
      tracker={params.tracker ?? null}
      signature={params.sig ?? null}
      cancelled={false}
    />
  );
}
