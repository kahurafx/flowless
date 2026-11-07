import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { listAccounts } from "@/data/accounts";
import { getSession } from "@/data/session";
import { AccountsGrid } from "./accounts-grid";

export const metadata = { title: "Accounts" };

export default function AccountsPage() {
  return (
    <>
      <PageHeader title="Accounts" description="Billing relationships: status, location and the balance derived from the ledger." />
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Accounts />
      </Suspense>
    </>
  );
}

async function Accounts() {
  const { organization } = await getSession();
  const accounts = await listAccounts();
  return <AccountsGrid accounts={accounts} locale={organization.settings.locale} />;
}
