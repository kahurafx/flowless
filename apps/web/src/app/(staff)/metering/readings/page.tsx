import { READING_STATUSES } from "@flowless/shared-types";
import Link from "next/link";
import { Suspense } from "react";
import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listReadings } from "@/data/metering";
import { formatWhen } from "@/lib/dates";
import { SOURCE_LABELS, flagMarks, needsReview, unitsText } from "@/lib/metering-view";
import { RecordReadingDialog, ReviewButtons, VoidButton } from "./reading-dialogs";

export const metadata = { title: "Readings" };

// M-02, M-04, M-05, M-07: readings with their validation flags, and the review of the flagged ones.
export default function ReadingsPage({ searchParams }: PageProps<"/metering/readings">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Readings searchParams={searchParams} />
    </Suspense>
  );
}

const one = (value: string | string[] | undefined) => (typeof value === "string" && value !== "" ? value : undefined);

async function Readings({ searchParams }: { searchParams: PageProps<"/metering/readings">["searchParams"] }) {
  const params = await searchParams;
  const data = await listReadings({ review: one(params.review), status: one(params.status), meterId: one(params.meter), before: one(params.after) });
  const when = (d: Date) => formatWhen(d, data.locale, data.timeZone);
  const next = new URLSearchParams(Object.entries(params).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])));
  if (data.next) next.set("after", data.next);
  return (
    <>
      <PageHeader
        title="Readings"
        description="Every reading with the units since the previous one. A reading the checks doubt is flagged and kept out of automatic billing until a reviewer approves or voids it. Readings are never edited: a correction is a new reading."
        actions={data.canCapture && <RecordReadingDialog />}
      />
      <ListFilters
        filters={[
          { param: "review", label: "All readings", options: [{ value: "1", label: "Waiting for review" }] },
          { param: "status", label: "Any status", options: READING_STATUSES.map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) })) },
        ]}
      />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Read</TableHead>
              <TableHead>Meter</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Dial</TableHead>
              <TableHead className="text-right">Units</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Checks</TableHead>
              {data.canApprove && <TableHead className="w-0" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                  {params.review === "1" ? "Nothing is waiting for review." : "No readings match."}
                </TableCell>
              </TableRow>
            ) : (
              data.rows.map((r) => {
                const l = r.accountId ? data.labels[r.accountId] : undefined;
                return (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">{when(r.readAt)}</TableCell>
                    <TableCell>
                      <Link href={`/metering/meters/${r.meterId}`} className="text-primary hover:underline">
                        {data.serials[r.meterId] ?? r.meterId.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>{l ? <Link href={`/accounts/${encodeURIComponent(l.number)}`} className="text-primary hover:underline">{l.number}</Link> : "-"}</TableCell>
                    <TableCell className="text-right tabular">{r.value}</TableCell>
                    <TableCell className="text-right tabular">{unitsText(r)}</TableCell>
                    <TableCell>
                      {SOURCE_LABELS[r.source]}
                      {r.purpose !== "routine" && <Badge variant="outline" className="ml-1">{r.purpose}</Badge>}
                    </TableCell>
                    <TableCell>
                      {r.status !== "valid" ? <Badge variant="outline">{r.status}</Badge> : r.cleared ? <Badge variant="success">Cleared</Badge> : <Badge variant="warning">Needs review</Badge>}
                      {r.rolloverConfirmed && <Badge variant="info" className="ml-1">Rollover</Badge>}
                      {flagMarks(r.flags).map((f) => (
                        <Badge key={f.code} variant={f.blocking ? "destructive" : "secondary"} className="ml-1" title={f.label}>
                          {f.label}
                        </Badge>
                      ))}
                    </TableCell>
                    {data.canApprove && (
                      <TableCell>
                        {needsReview(r) ? <ReviewButtons readingId={r.id} flags={r.flags} rolloverConfirmed={r.rolloverConfirmed} /> : r.status === "valid" ? <VoidButton readingId={r.id} /> : null}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      {data.next && (
        <div className="mt-3 flex justify-end">
          <Button variant="outline" render={<Link href={`/metering/readings?${next.toString()}`} />}>
            Older readings
          </Button>
        </div>
      )}
    </>
  );
}
