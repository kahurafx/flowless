import { METER_KINDS, METER_STATUSES } from "@flowless/shared-types";
import Link from "next/link";
import { Suspense } from "react";
import { ListFilters, NextPage } from "@/components/list-filters";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listMeters } from "@/data/metering";
import { METER_KIND_LABELS, METER_STATUS_LABELS } from "@/lib/metering-view";
import { RegisterMeterDialog } from "./meter-dialogs";

export const metadata = { title: "Meters" };

// M-01, M-12: the meter register and its lifecycle.
export default function MetersPage({ searchParams }: PageProps<"/metering/meters">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Meters searchParams={searchParams} />
    </Suspense>
  );
}

const one = (value: string | string[] | undefined) => (typeof value === "string" && value !== "" ? value : undefined);

async function Meters({ searchParams }: { searchParams: PageProps<"/metering/meters">["searchParams"] }) {
  const params = await searchParams;
  const data = await listMeters({ status: one(params.status), kind: one(params.kind), q: one(params.q), after: one(params.after) });
  return (
    <>
      <PageHeader
        title="Meters"
        description="Every meter by serial number, with where it is in its life: procured, in stock, installed, tested, replaced or disposed. Every move is logged."
        actions={data.canManage && <RegisterMeterDialog dmas={data.dmas} />}
      />
      <ListFilters
        search={{ placeholder: "Search serial number" }}
        filters={[
          { param: "status", label: "Any status", options: METER_STATUSES.map((s) => ({ value: s, label: METER_STATUS_LABELS[s] })) },
          { param: "kind", label: "Any kind", options: METER_KINDS.map((k) => ({ value: k, label: METER_KIND_LABELS[k] })) },
        ]}
      />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Serial</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Dial digits</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.meters.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  No meters match.{data.canManage ? " Register the first one to start installing." : ""}
                </TableCell>
              </TableRow>
            ) : (
              data.meters.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <Link href={`/metering/meters/${m.id}`} className="font-medium text-primary hover:underline">
                      {m.serial}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{m.model || "-"}</TableCell>
                  <TableCell>
                    {METER_KIND_LABELS[m.kind]}
                    {m.dmaId && <span className="text-muted-foreground"> · {data.dmaName(m.dmaId) ?? "DMA"}</span>}
                  </TableCell>
                  <TableCell>
                    <Badge variant={m.status === "installed" ? "success" : m.status === "disposed" ? "outline" : "secondary"}>{METER_STATUS_LABELS[m.status]}</Badge>
                  </TableCell>
                  <TableCell className="tabular">{m.dialDigits}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <NextPage cursor={data.next} />
    </>
  );
}
