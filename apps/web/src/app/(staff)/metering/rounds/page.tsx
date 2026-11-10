import Link from "next/link";
import { Suspense } from "react";
import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listRounds } from "@/data/metering";
import { formatWhen } from "@/lib/dates";
import { TakeRoundDialog } from "./take-round";

export const metadata = { title: "Reading rounds" };

// M-08: one eligibility snapshot per route and cycle date, shared by reading tasks and billing.
export default function RoundsPage({ searchParams }: PageProps<"/metering/rounds">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Rounds searchParams={searchParams} />
    </Suspense>
  );
}

const one = (value: string | string[] | undefined) => (typeof value === "string" && value !== "" ? value : undefined);

async function Rounds({ searchParams }: { searchParams: PageProps<"/metering/rounds">["searchParams"] }) {
  const params = await searchParams;
  const data = await listRounds({ routeId: one(params.route) });
  return (
    <>
      <PageHeader
        title="Reading rounds"
        description="For each route and cycle date, the snapshot of which service points are eligible and why. Reading tasks are derived from it, and the billing cycle expects exactly the same accounts."
        actions={data.canTake && <TakeRoundDialog routes={data.routes} />}
      />
      <ListFilters filters={[{ param: "route", label: "All routes", options: data.routes.map((r) => ({ value: r.id, label: r.name })) }]} />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Cycle date</TableHead>
              <TableHead>Route</TableHead>
              <TableHead>Taken</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.snapshots.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                  No snapshots yet. Opening a billing cycle or taking one here creates it.
                </TableCell>
              </TableRow>
            ) : (
              data.snapshots.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <Link href={`/metering/rounds/${s.id}`} className="font-medium text-primary hover:underline">
                      {s.cycleDate}
                    </Link>
                  </TableCell>
                  <TableCell>{s.routeName}</TableCell>
                  <TableCell className="text-muted-foreground">{formatWhen(s.takenAt, data.locale, data.timeZone)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
