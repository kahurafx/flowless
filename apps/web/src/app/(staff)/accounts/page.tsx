import { COMMERCIAL_STATUSES, SERVICE_STATES, type CommercialStatus, type ServiceState } from "@flowless/shared-types";
import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { ListFilters, NextPage } from "@/components/list-filters";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { listAccounts } from "@/data/accounts";
import { commercialStatusLabel, serviceStateLabel } from "@/lib/account-labels";
import { AccountsTable } from "./accounts-table";

export const metadata = { title: "Accounts" };

// C-02, C-03: find an account by number, customer or phone; filter by either status axis.
export default function AccountsPage({ searchParams }: PageProps<"/accounts">) {
  return (
    <>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Accounts searchParams={searchParams} />
      </Suspense>
    </>
  );
}

const one = (value: string | string[] | undefined) => (typeof value === "string" && value !== "" ? value : undefined);
const oneOf = <T extends string>(value: string | string[] | undefined, allowed: readonly T[]): T | undefined => allowed.find((a) => a === one(value));

async function Accounts({ searchParams }: { searchParams: PageProps<"/accounts">["searchParams"] }) {
  const params = await searchParams;
  const data = await listAccounts({
    q: one(params.q),
    commercialStatus: oneOf<CommercialStatus>(params.status, COMMERCIAL_STATUSES),
    serviceStatus: oneOf<ServiceState>(params.service, SERVICE_STATES),
    areaId: one(params.area),
    routeId: one(params.route),
    after: one(params.after),
  });
  return (
    <>
      <PageHeader
        title="Accounts"
        description="Billing relationships: find one by number, customer name or phone, and see where it stands on both status axes."
        actions={
          data.canCreate && (
            <Button render={<Link href="/accounts/new" />}>
              <PlusIcon />
              New account
            </Button>
          )
        }
      />
      <ListFilters
        search={{ placeholder: "Search number, customer or phone" }}
        filters={[
          { param: "status", label: "All statuses", options: COMMERCIAL_STATUSES.map((s) => ({ value: s, label: commercialStatusLabel[s] })) },
          { param: "service", label: "Any service", options: SERVICE_STATES.map((s) => ({ value: s, label: serviceStateLabel[s] })) },
          ...(data.searched ? [] : [{ param: "area", label: "All areas", options: data.areas.map((a) => ({ value: a.id, label: a.name })) }]),
          ...(data.searched ? [] : [{ param: "route", label: "All routes", options: data.routes.map((r) => ({ value: r.id, label: r.name })) }]),
        ]}
      />
      <AccountsTable rows={data.rows} showCategory={data.showCategory} searched={data.searched} />
      <NextPage cursor={data.nextCursor} />
    </>
  );
}
