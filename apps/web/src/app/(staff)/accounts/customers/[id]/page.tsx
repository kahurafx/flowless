import { AlertTriangleIcon, ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { CommercialStatusBadge, ServiceStatusBadge } from "@/components/status-badges";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getCustomerPage } from "@/data/customers";
import { customerTypeLabel } from "@/lib/account-labels";
import { accountHref } from "../../accounts-table";
import { ContactsManager, EditCustomer } from "./customer-editor";

export const metadata = { title: "Customer" };

export default function CustomerPage({ params }: PageProps<"/accounts/customers/[id]">) {
  return (
    <>
      <Button variant="ghost" className="-ml-2.5 mb-2" render={<Link href="/accounts/customers" />}>
        <ArrowLeftIcon />
        Customers
      </Button>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Customer params={params} />
      </Suspense>
    </>
  );
}

async function Customer({ params }: { params: PageProps<"/accounts/customers/[id]">["params"] }) {
  const { id } = await params;
  const { customer, duplicates, canEdit } = await getCustomerPage(id);
  return (
    <>
      <PageHeader
        eyebrow={customerTypeLabel[customer.type]}
        title={customer.name}
        description={[customer.nationalId, customer.registrationNumber, customer.language].filter(Boolean).join(" · ") || undefined}
        actions={canEdit && <EditCustomer customer={customer} />}
      />
      <div className="grid gap-6">
        {duplicates.length > 0 && (
          <div role="status" className="grid gap-1 rounded-xl bg-warning/12 p-3 text-sm text-warning">
            <p className="flex items-center gap-2 font-medium">
              <AlertTriangleIcon className="size-4" />
              This customer may be a duplicate
            </p>
            <ul className="text-foreground">
              {duplicates.map((d) => (
                <li key={d.customer.id}>
                  <Link href={`/accounts/customers/${d.customer.id}`} className="font-medium underline">
                    {d.customer.name}
                  </Link>{" "}
                  <span className="text-xs text-muted-foreground">shares a phone or id number</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {customer.notes && <p className="max-w-prose rounded-xl border bg-card p-4 text-sm whitespace-pre-wrap">{customer.notes}</p>}
        <ContactsManager customerId={customer.id} contacts={customer.contacts} canEdit={canEdit} />
        <section aria-labelledby="customer-accounts" className="grid gap-3 rounded-xl border bg-card p-4">
          <h2 id="customer-accounts" className="text-base font-semibold">
            Accounts
          </h2>
          {customer.accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No accounts you can see.</p>
          ) : (
            <ul className="grid gap-2">
              {customer.accounts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                  <Link href={accountHref(a.number)} className="font-mono text-xs font-medium text-primary hover:underline">
                    {a.number}
                  </Link>
                  <span className="flex flex-wrap gap-1">
                    <CommercialStatusBadge status={a.commercialStatus} />
                    <ServiceStatusBadge service={a.serviceStatus === "CONNECTED" ? { state: "CONNECTED" } : { state: "DISCONNECTED", reason: a.serviceStatusReason ?? "" }} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
