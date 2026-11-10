import { READING_OUTCOMES } from "@flowless/shared-types";
import Link from "next/link";
import { Suspense } from "react";
import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listVisits } from "@/data/metering";
import { formatWhen } from "@/lib/dates";
import { DISPOSITION_LABELS, OUTCOME_FIELD_LABELS } from "@/lib/policy-settings";

export const metadata = { title: "Visits" };

// M-06, M-09: each visit to read a service point, whatever was found.
export default function VisitsPage({ searchParams }: PageProps<"/metering/visits">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Visits searchParams={searchParams} />
    </Suspense>
  );
}

const one = (value: string | string[] | undefined) => (typeof value === "string" && value !== "" ? value : undefined);

async function Visits({ searchParams }: { searchParams: PageProps<"/metering/visits">["searchParams"] }) {
  const params = await searchParams;
  const data = await listVisits({ outcome: one(params.outcome), cycleDate: one(params.cycle) });
  return (
    <>
      <PageHeader
        title="Visits"
        description="Every attempt to read a service point with what the reader found. The disposition is what billing does for that outcome under the mapping in force today; change it in Metering settings."
      />
      <ListFilters filters={[{ param: "outcome", label: "Any outcome", options: READING_OUTCOMES.map((o) => ({ value: o, label: OUTCOME_FIELD_LABELS[o] })) }]} />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Visited</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Billing does</TableHead>
              <TableHead>Cycle date</TableHead>
              <TableHead>Reader</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  No visits recorded yet. Technicians record them from the field app.
                </TableCell>
              </TableRow>
            ) : (
              data.rows.map((v) => {
                const l = v.accountId ? data.labels[v.accountId] : undefined;
                return (
                  <TableRow key={v.id}>
                    <TableCell className="whitespace-nowrap">{formatWhen(v.attemptedAt, data.locale, data.timeZone)}</TableCell>
                    <TableCell>{l ? <Link href={`/accounts/${encodeURIComponent(l.number)}`} className="text-primary hover:underline">{l.number}</Link> : "-"}</TableCell>
                    <TableCell>
                      <Badge variant={v.outcome === "read_ok" ? "success" : "warning"}>{OUTCOME_FIELD_LABELS[v.outcome]}</Badge>
                    </TableCell>
                    <TableCell>{DISPOSITION_LABELS[v.disposition]}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{v.cycleDate ?? "-"}</TableCell>
                    <TableCell>{data.readers[v.id] || "-"}</TableCell>
                    <TableCell className="max-w-64 truncate text-muted-foreground" title={v.note}>
                      {[...v.tags, v.note].filter(Boolean).join(" · ")}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
