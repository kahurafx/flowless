import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { CommercialStatusBadge, ServiceStatusBadge } from "@/components/status-badges";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { accountNumberFrom, getAccountPage } from "@/data/accounts";
import { ActivationPanel } from "./activation-panel";
import { CommandsSection, CustomerSection, HoldersSection, Overview, ServicePointsSection } from "./account-sections";
import { LifecycleActions } from "./lifecycle-actions";
import { RelocationsPanel } from "./relocations-panel";
import { StatementSection } from "./statement-section";

export const metadata = { title: "Account" };

export default function AccountPage({ params }: PageProps<"/accounts/[number]">) {
  return (
    <>
      <Button variant="ghost" className="-ml-2.5 mb-2" render={<Link href="/accounts" />}>
        <ArrowLeftIcon />
        Accounts
      </Button>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Account params={params} />
      </Suspense>
    </>
  );
}

async function Account({ params }: { params: PageProps<"/accounts/[number]">["params"] }) {
  const { number } = await params;
  const page = await getAccountPage(accountNumberFrom(number));
  const { account } = page;

  return (
    <>
      <PageHeader
        eyebrow={`Account ${account.number}`}
        title={account.customerName}
        description={
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <CommercialStatusBadge status={account.commercialStatus} />
            <ServiceStatusBadge service={account.serviceStatus === "CONNECTED" ? { state: "CONNECTED" } : { state: "DISCONNECTED", reason: account.serviceStatusReason ?? "" }} />
            {account.serviceStatus === "DISCONNECTED" && account.serviceStatusReason && <span className="text-xs text-muted-foreground">{account.serviceStatusReason}</span>}
          </div>
        }
      />
      <div className="grid gap-6">
        <LifecycleActions page={page} />
        <Overview page={page} />
        <ActivationPanel page={page} />
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <CustomerSection page={page} />
          <ServicePointsSection page={page} />
        </div>
        <RelocationsPanel page={page} />
        <HoldersSection page={page} />
        <CommandsSection page={page} />
        <Suspense fallback={<Skeleton className="h-48" />}>
          <StatementSection account={{ id: account.id, number: account.number }} />
        </Suspense>
      </div>
    </>
  );
}
