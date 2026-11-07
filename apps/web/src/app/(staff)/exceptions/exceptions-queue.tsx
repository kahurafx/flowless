"use client";

import type { ExceptionType } from "@flowless/shared-types";
import { ArrowUpRightIcon, RotateCwIcon } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { DataGrid, gridColumnHelper } from "@/components/data-grid";
import { AgeBadge, exceptionTypeLabel } from "@/components/status-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { ExceptionRow } from "@/data/exceptions";
import { assignException, resolveException, retryException, startException } from "./actions";

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
      <span className="flex min-w-56 items-center gap-2 font-medium">
        {info.getValue()}
        {info.row.original.occurrences > 1 && (
          <Badge variant="secondary" className="tabular">
            ×{info.row.original.occurrences}
          </Badge>
        )}
        {info.row.original.demo && <Badge variant="outline">Demo</Badge>}
      </span>
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

interface Member {
  id: string;
  name: string;
}

export function ExceptionsQueue({
  rows,
  locale,
  timeZone,
  owners,
  members,
  canAct,
  initialFilters,
}: {
  rows: ExceptionRow[];
  locale: string;
  timeZone: string;
  owners: readonly string[];
  members: Member[];
  canAct: boolean;
  initialFilters: { id: string; value: string }[];
}) {
  // Track the id, not the row: after an action the page refreshes with new data, and a
  // resolved exception leaves the queue, which closes the panel.
  const [openId, setOpenId] = useState<string | null>(null);
  const [shownId, setShownId] = useState<string | null>(null);
  const open = rows.find((r) => r.id === openId) ?? null;
  const shown = rows.find((r) => r.id === shownId) ?? null;
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
        onOpenRow={(row) => {
          setShownId(row.id);
          setOpenId(row.id);
        }}
        initialSorting={[{ id: "ageDays", desc: true }]}
        initialColumnFilters={initialFilters}
        hiddenColumns={["ageBucket"]}
        facets={[
          { columnId: "type", label: "Queues", options: types.map((t) => ({ value: t, label: exceptionTypeLabel[t as ExceptionType] })) },
          { columnId: "ageBucket", label: "Ages", options: ageOptions },
          { columnId: "owner", label: "Owners", options: [...owners, UNASSIGNED].map((name) => ({ value: name, label: name })) },
        ]}
      />
      {/* A parallel detail panel from the right; it leaves the way it came (apple-design §7). */}
      <Sheet open={open !== null} onOpenChange={(next) => !next && setOpenId(null)}>
        <SheetContent className="w-full sm:max-w-md">
          {shown && (
            <ExceptionDetail key={shown.id} row={shown} locale={locale} timeZone={timeZone} members={members} canAct={canAct} />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function ExceptionDetail({
  row,
  locale,
  timeZone,
  members,
  canAct,
}: {
  row: ExceptionRow;
  locale: string;
  timeZone: string;
  members: Member[];
  canAct: boolean;
}) {
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
        <dd className="font-mono text-xs break-all">{row.subject.ref}</dd>
        {row.occurrences > 1 && (
          <>
            <dt className="text-muted-foreground">Occurrences</dt>
            <dd className="tabular">{row.occurrences}</dd>
          </>
        )}
      </dl>
      {row.demo ? (
        <p className="mx-4 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
          Demo data: the {row.source.replace("-", " ")} module raises these once it is built.
        </p>
      ) : (
        canAct && <ExceptionActions row={row} members={members} />
      )}
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

function ExceptionActions({ row, members }: { row: ExceptionRow; members: Member[] }) {
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const act = (action: () => Promise<{ error: string | null }>, done: string) =>
    startTransition(async () => {
      const { error } = await action();
      if (error) toast.error(error);
      else toast.success(done);
    });

  return (
    <div className="flex flex-col gap-4 border-t px-4 pt-4">
      <div className="grid gap-2">
        <Label htmlFor="exception-owner">Owner</Label>
        <Select
          value={row.owner?.id ?? UNASSIGNED}
          onValueChange={(v) => act(() => assignException(row.id, v === UNASSIGNED ? null : String(v)), "Owner changed")}
          disabled={pending}
        >
          <SelectTrigger id="exception-owner" className="w-full">
            <SelectValue>{(v: string) => members.find((m) => m.id === v)?.name ?? row.owner?.name ?? UNASSIGNED}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNASSIGNED}>{UNASSIGNED}</SelectItem>
            {members.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-wrap gap-2">
        {row.status === "open" && (
          <Button variant="outline" disabled={pending} onClick={() => act(() => startException(row.id), "Marked in progress")}>
            Start
          </Button>
        )}
        {row.retryable && (
          <Button variant="outline" disabled={pending} onClick={() => act(() => retryException(row.id), "Queued to run again")}>
            <RotateCwIcon />
            Retry
          </Button>
        )}
      </div>
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          act(() => resolveException(row.id, note), "Resolved");
        }}
      >
        <Label htmlFor="exception-note">What was done</Label>
        <Textarea id="exception-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} required />
        <Button type="submit" disabled={pending || !note.trim()}>
          Resolve
        </Button>
      </form>
    </div>
  );
}
