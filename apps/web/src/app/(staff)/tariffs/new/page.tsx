import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getSimulationOptions } from "@/data/billing-ops";
import { getNewTariffForm } from "@/data/tariffs";
import { NewTariffForm } from "./new-tariff-form";

export const metadata = { title: "New tariff" };

// T-01: a tariff and its first version.
export default function NewTariffPage() {
  return (
    <>
      <Button variant="ghost" className="-ml-2.5 mb-2" render={<Link href="/tariffs" />}>
        <ArrowLeftIcon />
        Tariffs
      </Button>
      <Suspense fallback={<Skeleton className="h-96 max-w-3xl" />}>
        <Form />
      </Suspense>
    </>
  );
}

async function Form() {
  const [form, simulation] = await Promise.all([getNewTariffForm(), getSimulationOptions()]);
  return (
    <>
      <PageHeader title="New tariff" description="Choose how consumption is priced and enter the first version. Later changes are new versions, never edits." />
      <NewTariffForm next={form.next} currency={form.currency} locale={form.locale} simulation={simulation} />
    </>
  );
}
