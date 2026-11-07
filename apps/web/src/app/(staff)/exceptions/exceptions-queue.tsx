"use client";

import type { ExceptionType } from "@flowless/shared-types";
import { ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DataGrid, gridColumnHelper } from "@/components/data-grid";
import { AgeBadge, exceptionTypeLabel } from "@/components/status-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { ExceptionRow } from "@/data/exceptions";

const UNASSIGNED = "Unassigned";
const col = gridColumnHelper<ExceptionRow>();

const columns = col.columns([
  col.accessor("ageDays", {
    header: "Age",
    sortFn: "basic",
    cell: (info) => <AgeBadge days={info.getValue()} bucket={info.row.original.ageBucket} />,
  }),
  col.accessor("title", {
    header: "Exception",
    sortFn: "text",
    cell: (info) => (
      <span className="block min-w-56 font-medium">{info.getValue()}</span>
    ),
  }),
  col.accessor((row) => row.subject.ref, {
    id: "subject",
    header: "Subject",
    sortFn: "alphanumeric",
    cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
  }),
  col.accessor((row) => row.owner?.name ?? UNASSIGNED, {
    id: "owner",
    header: "Owner",
    sortFn: "text",
    filterFn: "equalsString",
    cell: (info) =>
      info.getValue() === UNASSIGNED ? (
        <Badge variant="warning">Unassigned</Badge>
      ) : (
        <span className="whitespace-nowrap">{info.getValue()}</span>
      ),
  }),
  col.accessor("type", { id: "type", header: "Queue", filterFn: "equalsString", cell: (info) => <span className="whitespace-nowrap text-muted-foreground">{exceptionTypeLabel[info.getValue()]}</span> }),
  // Filter-only: drives the Ages facet, hidden from the layout.
  col.accessor("ageBucket", { id: "ageBucket", enableGlobalFilter: false, filterFn: "equalsString" }),
]);

const ageOptions = [
  { value: "fresh", label: "Fresh" },
  { value: "ageing", label: "Ageing" },
  { value: "overdue", label: "Overdue" },
];

export function ExceptionsQueue({
  rows,
  locale,
  timeZone,
  staff,
  initialFilters,
}: {
  rows: ExceptionRow[];
  locale: string;
  timeZone: string;
  staff: readonly string[];
  initialFilters: { id: string; value: string }[];
}) {
  const [open, setOpen] = useState<ExceptionRow | null>(null);
  const types = [...new Set(rows.map((r) => r.type))];

  return (
    <>
      <DataGrid
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        searchPlaceholder="Search exceptions"
        viewsKey="exceptions"
        emptyMessage="No open exceptions."
        onOpenRow={setOpen}
        initialSorting={[{ id: "ageDays", desc: true }]}
        initialColumnFilters={initialFilters}
        hiddenColumns={["ageBucket"]}
        facets={[
          { columnId: "type", label: "Queues", options: types.map((t) => ({ value: t, label: exceptionTypeLabel[t as ExceptionType] })) },
          { columnId: "ageBucket", label: "Ages", options: ageOptions },
          { columnId: "owner", label: "Owners", options: [...staff, UNASSIGNED].map((name) => ({ value: name, label: name })) },
        ]}
      />
      {/* A parallel detail panel from the right; it leaves the way it came (apple-design §7). */}
      <Sheet open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <SheetContent className="w-full sm:max-w-md">
          {open && <ExceptionDetail row={open} locale={locale} timeZone={timeZone} />}
        </SheetContent>
      </Sheet>
    </>
  );
}

function ExceptionDetail({ row, locale, timeZone }: { row: ExceptionRow; locale: string; timeZone: string }) {
  const raised = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(row.raisedAt);
  return (
    <>
      <SheetHeader className="gap-2 pr-12">
        <div className="flex flex-wrap items-center gap-2">
          <AgeBadge days={row.ageDays} bucket={row.ageBucket} />
          <Badge variant="outline">{exceptionTypeLabel[row.type]}</Badge>
          {row.status === "in_progress" && <Badge variant="info">In progress</Badge>}
        </div>
        <SheetTitle className="text-lg font-semibold">{row.title}</SheetTitle>
        <SheetDescription>{row.detail}</SheetDescription>
      </SheetHeader>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 px-4 text-sm">
        <dt className="text-muted-foreground">Owner</dt>
        <dd>{row.owner?.name ?? <Badge variant="warning">Unassigned</Badge>}</dd>
        <dt className="text-muted-foreground">Raised</dt>
        <dd className="tabular">{raised}</dd>
        <dt className="text-muted-foreground">Source</dt>
        <dd className="capitalize">{row.source.replace("-", " ")}</dd>
        <dt className="text-muted-foreground">Subject</dt>
        <dd className="font-mono text-xs">{row.subject.ref}</dd>
      </dl>
      {row.subject.kind === "account" && (
        <div className="mt-auto p-4">
          <Button className="w-full" render={<Link href={`/accounts/${encodeURIComponent(row.subject.ref)}`} />}>
            Open account
            <ArrowUpRightIcon />
          </Button>
        </div>
      )}
    </>
  );
}
