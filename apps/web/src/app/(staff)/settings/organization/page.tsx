import type { ModuleKey } from "@flowless/shared-types";
import { CheckIcon } from "lucide-react";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getRegional } from "@/data/config";
import { getSession } from "@/data/session";
import { LANGUAGES } from "@/lib/languages";
import { RegionalForm } from "./regional-form";

export const metadata = { title: "Organization" };

export default function OrganizationSettingsPage() {
  return (
    <>
      <PageHeader title="Organization" description="Time zone, language, currency and the modules this organization is licensed for." />
      <Suspense fallback={<Skeleton className="h-64" />}>
        <Settings />
      </Suspense>
    </>
  );
}

const moduleLabels: Record<ModuleKey, string> = {
  accounts: "Customers and accounts",
  tariffs: "Tariffs and charge catalog",
  metering: "Metering and readings",
  billing: "Billing and sub-ledger",
  payments: "Payments",
  communications: "Communications",
  collections: "Collections",
  "work-orders": "Work orders",
  inventory: "Inventory",
  gis: "GIS and network",
  nrw: "Non-revenue water",
  portal: "Customer portal",
  reporting: "Reporting",
  migration: "Import and migration",
};

async function Settings() {
  const [{ organization }, regional] = await Promise.all([getSession(), getRegional()]);
  const when = new Intl.DateTimeFormat(regional.locale, { dateStyle: "medium", timeStyle: "short", timeZone: regional.timeZone });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex flex-col gap-6">
        <section aria-labelledby="identity" className="rounded-xl border bg-card p-4">
          <h2 id="identity" className="mb-3 font-semibold">
            Organization
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Name</dt>
            <dd className="font-medium">{organization.name}</dd>
            <dt className="text-muted-foreground">Organization code</dt>
            <dd className="font-mono">{organization.code.toUpperCase()}</dd>
            <dt className="text-muted-foreground">Currency</dt>
            <dd>
              <span className="font-mono">{organization.settings.currency}</span>
              <span className="text-muted-foreground"> · set when Flowless onboarded you; all money is held in it</span>
            </dd>
          </dl>
        </section>

        <section aria-labelledby="regional" className="rounded-xl border bg-card p-4">
          <h2 id="regional" className="mb-1 font-semibold">
            Time zone and language
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Billing periods and due dates are counted in this time zone. Documents and messages use this language.
          </p>
          {regional.canManage ? (
            <RegionalForm
              key={regional.latestVersion}
              timeZone={regional.timeZone}
              locale={regional.locale}
              latestVersion={regional.latestVersion}
            />
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Time zone</dt>
              <dd>{regional.timeZone.replace(/_/g, " ")}</dd>
              <dt className="text-muted-foreground">Language</dt>
              <dd>{LANGUAGES[regional.locale] ?? regional.locale}</dd>
            </dl>
          )}
          {regional.history.length > 0 && (
            <div className="mt-6 border-t pt-4">
              <h3 className="mb-2 text-sm font-medium">Changes</h3>
              <ol className="flex flex-col gap-3 text-sm">
                {regional.history.map((v) => (
                  <li key={v.version} className="flex flex-col gap-0.5">
                    <span>
                      {v.value.timeZone.replace(/_/g, " ")} · {LANGUAGES[v.value.locale] ?? v.value.locale}
                      {v.version === regional.version && <span className="ml-2 text-xs text-success">In force</span>}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {v.by} · {when.format(v.effectiveFrom)}
                      {v.reason ? ` · ${v.reason}` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      </div>

      <section aria-labelledby="modules" className="self-start rounded-xl border bg-card p-4">
        <h2 id="modules" className="mb-3 font-semibold">
          Licensed modules
        </h2>
        <ul className="flex flex-col gap-2 text-sm">
          {organization.entitlements.map((m) => (
            <li key={m} className="flex items-center gap-2">
              <CheckIcon className="size-4 text-success" />
              {moduleLabels[m]}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
