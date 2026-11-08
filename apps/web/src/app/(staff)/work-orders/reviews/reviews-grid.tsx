"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { DataGrid, gridColumnHelper } from "@/components/data-grid";
import { outcomeLabel, PriorityBadge } from "@/components/work-badges";
import { Badge } from "@/components/ui/badge";
import type { ReviewRow } from "@/data/work-orders";
import { formatWhen } from "@/lib/dates";

const col = gridColumnHelper<ReviewRow>();

export function ReviewsGrid({ rows, locale, timeZone }: { rows: ReviewRow[]; locale: string; timeZone: string }) {
  const router = useRouter();
  const columns = useMemo(
    () =>
      col.columns([
        col.accessor("code", {
          header: "Job",
          sortFn: "alphanumeric",
          cell: (info) => (
            <Link href={`/work-orders/${info.row.original.id}`} className="font-mono text-xs font-medium whitespace-nowrap hover:underline" onClick={(e) => e.stopPropagation()}>
              {info.getValue()}
            </Link>
          ),
        }),
        col.accessor("title", {
          header: "Title",
          sortFn: "text",
          cell: (info) => (
            <span className="flex min-w-48 flex-col">
              <span className="font-medium">{info.getValue()}</span>
              <span className="text-xs text-muted-foreground">{info.row.original.kindLabel}</span>
            </span>
          ),
        }),
        col.accessor((row) => row.submitter ?? "Unknown", { id: "submitter", header: "Submitted by", sortFn: "text", cell: (info) => <span className="whitespace-nowrap">{info.getValue()}</span> }),
        col.accessor((row) => row.submission?.at.getTime() ?? 0, {
          id: "submittedAt",
          header: "Submitted",
          sortFn: "basic",
          cell: (info) => <span className="whitespace-nowrap tabular">{info.row.original.submission ? formatWhen(info.row.original.submission.at, locale, timeZone) : ""}</span>,
        }),
        col.accessor((row) => row.submission?.outcome ?? "done", {
          id: "outcome",
          header: "Result",
          sortFn: "text",
          cell: (info) => outcomeLabel[info.getValue()],
        }),
        col.accessor("priority", { header: "Priority", enableSorting: false, cell: (info) => <PriorityBadge priority={info.getValue()} /> }),
        col.accessor("own", { header: "Reviewer", enableSorting: false, cell: (info) => (info.getValue() ? <Badge variant="outline">Yours: another reviewer must decide</Badge> : null) }),
      ]),
    [locale, timeZone],
  );
  return (
    <DataGrid
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      searchPlaceholder="Search submissions"
      viewsKey="job-reviews"
      emptyMessage="Nothing is waiting for review."
      onOpenRow={(row) => router.push(`/work-orders/${row.id}`)}
      initialSorting={[{ id: "submittedAt", desc: false }]}
    />
  );
}
