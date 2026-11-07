import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { listExceptions } from "@/data/exceptions";
import { getSession } from "@/data/session";
import { ExceptionsQueue } from "./exceptions-queue";

export const metadata = { title: "Exceptions" };

// X-02: the exception queue is the main operational screen. NF-24: owner and age on every row.
export default function ExceptionsPage({ searchParams }: PageProps<"/exceptions">) {
  return (
    <>
      <PageHeader
        title="Exceptions"
        description="Everything the system could not finish on its own: who owns it and how long it has waited."
      />
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Queue searchParams={searchParams} />
      </Suspense>
    </>
  );
}

const FILTER_PARAMS = { type: "type", age: "ageBucket", owner: "owner" } as const;

async function Queue({ searchParams }: { searchParams: PageProps<"/exceptions">["searchParams"] }) {
  const [params, { rows }, { organization }] = await Promise.all([searchParams, listExceptions(), getSession()]);
  const initialFilters = Object.entries(FILTER_PARAMS).flatMap(([param, id]) => {
    const value = params[param];
    return typeof value === "string" ? [{ id, value }] : [];
  });
  return (
    <ExceptionsQueue
      // Remount when the deep link changes, so the grid picks up the new filters.
      key={JSON.stringify(initialFilters)}
      rows={rows}
      locale={organization.settings.locale}
      timeZone={organization.settings.timeZone}
      staff={organization.staff.map((p) => p.name)}
      initialFilters={initialFilters}
    />
  );
}
