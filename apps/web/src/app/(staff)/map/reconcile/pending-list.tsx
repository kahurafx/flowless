"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { DataGrid, gridColumnHelper } from "@/components/data-grid";
import { Badge } from "@/components/ui/badge";
import type { PendingBranch } from "@/data/gis";
import { formatWhen } from "@/lib/dates";

const col = gridColumnHelper<PendingBranch>();

export function PendingList({ rows, locale, timeZone }: { rows: PendingBranch[]; locale: string; timeZone: string }) {
  const router = useRouter();
  const columns = useMemo(
    () =>
      col.columns([
        col.accessor("branch", {
          header: "Branch",
          sortFn: "text",
          cell: (info) => <span className="font-mono text-xs break-all">{info.getValue()}</span>,
        }),
        col.accessor((row) => (row.origin ? `${row.origin.ref} ${row.origin.title}` : "Personal edits"), {
          id: "origin",
          header: "Belongs to",
          sortFn: "text",
          cell: (info) => {
            const origin = info.row.original.origin;
            return origin ? (
              <span className="flex min-w-48 flex-col">
                <Link href={`/work-orders/${origin.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                  <span className="font-mono text-xs">{origin.ref}</span> {origin.title}
                </Link>
                <span className="text-xs text-muted-foreground capitalize">{origin.status.replace("_", " ")}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">Personal edits</span>
            );
          },
        }),
        col.accessor((row) => row.authors.join(", "), { id: "authors", header: "Edited by", sortFn: "text" }),
        col.accessor("changes", { header: "Changes", sortFn: "basic", meta: { align: "end" }, cell: (info) => <span className="tabular">{info.getValue()}</span> }),
        col.accessor((row) => row.lastEditAt.getTime(), {
          id: "lastEdit",
          header: "Last edit",
          sortFn: "basic",
          cell: (info) => <span className="whitespace-nowrap tabular">{formatWhen(info.row.original.lastEditAt, locale, timeZone)}</span>,
        }),
        col.accessor((row) => row.origin?.status ?? "", {
          id: "ready",
          header: "Ready",
          enableSorting: false,
          cell: (info) => {
            const origin = info.row.original.origin;
            if (!origin) return <Badge variant="outline">No job</Badge>;
            if (origin.status === "completed") return <Badge variant="success">Job approved</Badge>;
            if (origin.status === "cancelled") return <Badge variant="destructive">Discard only</Badge>;
            return <Badge variant="warning">Job not finished</Badge>;
          },
        }),
      ]),
    [locale, timeZone],
  );
  return (
    <DataGrid
      data={rows}
      columns={columns}
      getRowId={(r) => r.branch}
      searchPlaceholder="Search branches"
      viewsKey="pending-branches"
      emptyMessage="Nothing is waiting to be posted."
      onOpenRow={(row) => router.push(`/map/reconcile/${encodeURIComponent(row.branch)}`)}
      initialSorting={[{ id: "lastEdit", desc: true }]}
    />
  );
}
