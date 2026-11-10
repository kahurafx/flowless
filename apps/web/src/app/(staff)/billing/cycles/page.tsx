import Link from "next/link";
import { Suspense } from "react";
import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listBillingCycles } from "@/data/billing-cycles";
import { formatWhen } from "@/lib/dates";
import { CYCLE_STATES, CYCLE_STATE_LABELS, FREQUENCY_LABELS, TRIGGER_LABELS, periodLabel } from "@/lib/cycle-view";
import { OpenCycleDialog } from "./open-cycle";

export const metadata = { title: "Billing cycles" };

// B-02: one billing cycle per route and period, driven through logged states.
export default function CyclesPage({ searchParams }: PageProps<"/billing/cycles">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Cycles searchParams={searchParams} />
    </Suspense>
  );
}

const one = (value: string | string[] | undefined) => (typeof value === "string" && value !== "" ? value : undefined);

async function Cycles({ searchParams }: { searchParams: PageProps<"/billing/cycles">["searchParams"] }) {
  const params = await searchParams;
  const data = await listBillingCycles({ routeId: one(params.route), state: one(params.state) });
  return (
    <>
      <PageHeader
        title="Billing cycles"
        description="A cycle bills one route for one period. It moves through logged states, closes only when every expected account is explained, and then locks the period."
        actions={data.canRun && <OpenCycleDialog routes={data.routes} defaultPeriod={data.defaultPeriod} />}
      />
      <ListFilters
        filters={[
          { param: "route", label: "All routes", options: data.routes.map((r) => ({ value: r.id, label: r.name })) },
          { param: "state", label: "Any state", options: CYCLE_STATES.map((s) => ({ value: s, label: CYCLE_STATE_LABELS[s] })) },
        ]}
      />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Period</TableHead>
              <TableHead>Route</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Frequency</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Opened</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  No billing cycles yet.{data.canRun ? " Open one for a route and period to start billing it." : " Someone with permission to run billing opens them."}
                </TableCell>
              </TableRow>
            ) : (
              data.rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <Link href={`/billing/cycles/${c.id}`} className="font-medium text-primary hover:underline">
                      {periodLabel(c.period, data.locale)}
                    </Link>
                  </TableCell>
                  <TableCell>{c.routeName}</TableCell>
                  <TableCell>
                    <Badge variant={c.state === "closed" ? "outline" : c.state === "review" ? "warning" : "info"}>{CYCLE_STATE_LABELS[c.state]}</Badge>
                  </TableCell>
                  <TableCell>{FREQUENCY_LABELS[c.frequency]}</TableCell>
                  <TableCell>{TRIGGER_LABELS[c.trigger]}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatWhen(c.createdAt, data.locale, "UTC", "date")}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
