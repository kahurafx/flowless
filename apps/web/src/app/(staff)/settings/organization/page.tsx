import { CheckIcon } from "lucide-react";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getSession } from "@/data/session";

export const metadata = { title: "Organization" };

export default function OrganizationSettingsPage() {
  return (
    <>
      <PageHeader title="Organization" description="Locale, currency and the modules this organization is licensed for." />
      <Suspense fallback={<Skeleton className="h-64" />}>
        <Settings />
      </Suspense>
    </>
  );
}

const moduleLabels: Record<string, string> = {
  accounts: "Customers and accounts",
  tariffs: "Tariffs and charge catalog",
  metering: "Metering and readings",
  billing: "Billing and sub-ledger",
  payments: "Payments",
  communications: "Communications",
  collections: "Collections",
  reporting: "Reporting",
};

async function Settings() {
  // Phase 1 swaps this for `organization.settings` over tRPC (the procedure already exists).
  const { organization } = await getSession();
  const { currency, timeZone, locale } = organization.settings;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section aria-labelledby="locale" className="rounded-xl border bg-card p-4">
        <h2 id="locale" className="mb-3 font-semibold">
          Locale (NF-33)
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Name</dt>
          <dd className="font-medium">{organization.name}</dd>
          <dt className="text-muted-foreground">Currency</dt>
          <dd className="font-mono">{currency}</dd>
          <dt className="text-muted-foreground">Time zone</dt>
          <dd>{timeZone}</dd>
          <dt className="text-muted-foreground">Locale</dt>
          <dd className="font-mono">{locale}</dd>
        </dl>
      </section>
      <section aria-labelledby="modules" className="rounded-xl border bg-card p-4">
        <h2 id="modules" className="mb-3 font-semibold">
          Licensed modules (K-04)
        </h2>
        <ul className="flex flex-col gap-2 text-sm">
          {organization.entitlements.map((m) => (
            <li key={m} className="flex items-center gap-2">
              <CheckIcon className="size-4 text-success" />
              {moduleLabels[m] ?? m}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
