"use client";

import { WORK_ORDER_STATUSES, WORK_PRIORITIES } from "@flowless/shared-types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { DataGrid, gridColumnHelper } from "@/components/data-grid";
import { OverdueBadge, PriorityBadge, priorityLabel, statusLabel, WorkStatusBadge } from "@/components/work-badges";
import type { JobRow } from "@/data/work-orders";
import { formatWhen } from "@/lib/dates";

const NOBODY = "Unassigned";
const col = gridColumnHelper<JobRow>();

function columnsFor(locale: string, timeZone: string) {
  return col.columns([
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
    col.accessor("status", { header: "Status", sortFn: "text", filterFn: "equalsString", cell: (info) => <WorkStatusBadge status={info.getValue()} /> }),
    col.accessor("priority", {
      header: "Priority",
      sortFn: (a, b, id) => WORK_PRIORITIES.indexOf(a.getValue(id)) - WORK_PRIORITIES.indexOf(b.getValue(id)),
      filterFn: "equalsString",
      cell: (info) => <PriorityBadge priority={info.getValue()} />,
    }),
    col.accessor((row) => row.assignee ?? row.crewName ?? NOBODY, {
      id: "assignee",
      header: "Assigned to",
      sortFn: "text",
      filterFn: "equalsString",
      cell: (info) => (info.getValue() === NOBODY ? <span className="text-muted-foreground">Unassigned</span> : <span className="whitespace-nowrap">{info.getValue()}</span>),
    }),
    col.accessor((row) => row.dueAt.getTime(), {
      id: "dueAt",
      header: "Due",
      sortFn: "basic",
      cell: (info) => (
        <span className="flex items-center gap-2 whitespace-nowrap tabular">
          {formatWhen(info.row.original.dueAt, locale, timeZone, "date")}
          {info.row.original.overdue && <OverdueBadge />}
        </span>
      ),
    }),
    // Filter-only columns: they drive the facets and take no space.
    col.accessor("kind", { id: "kind", enableGlobalFilter: false, filterFn: "equalsString" }),
    col.accessor((row) => (row.overdue ? "overdue" : "on_time"), { id: "overdue", enableGlobalFilter: false, filterFn: "equalsString" }),
  ]);
}

export function JobsGrid({
  rows,
  kinds,
  people,
  locale,
  timeZone,
  mineOnly,
}: {
  rows: JobRow[];
  kinds: { key: string; label: string }[];
  people: { id: string; name: string }[];
  locale: string;
  timeZone: string;
  mineOnly: boolean;
}) {
  const router = useRouter();
  const columns = useMemo(() => columnsFor(locale, timeZone), [locale, timeZone]);
  const assignees = [...new Set(rows.flatMap((r) => (r.assignee ?? r.crewName ? [(r.assignee ?? r.crewName)!] : [])))].sort();
  return (
    <DataGrid
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      searchPlaceholder="Search jobs"
      viewsKey={mineOnly ? "my-jobs" : "work-orders"}
      emptyMessage={mineOnly ? "Nothing is assigned to you." : "No jobs yet."}
      onOpenRow={(row) => router.push(`/work-orders/${row.id}`)}
      initialSorting={[{ id: "dueAt", desc: false }]}
      hiddenColumns={["kind", "overdue"]}
      facets={[
        { columnId: "status", label: "Statuses", options: WORK_ORDER_STATUSES.map((s) => ({ value: s, label: statusLabel[s] })) },
        { columnId: "kind", label: "Kinds", options: kinds.map((k) => ({ value: k.key, label: k.label })) },
        { columnId: "priority", label: "Priorities", options: WORK_PRIORITIES.map((p) => ({ value: p, label: priorityLabel[p] })) },
        ...(mineOnly || people.length <= 1
          ? []
          : [{ columnId: "assignee", label: "Assignees", options: [...assignees, NOBODY].map((name) => ({ value: name, label: name })) }]),
        {
          columnId: "overdue",
          label: "Timeliness",
          options: [
            { value: "overdue", label: "Overdue" },
            { value: "on_time", label: "Not overdue" },
          ],
        },
      ]}
    />
  );
}
