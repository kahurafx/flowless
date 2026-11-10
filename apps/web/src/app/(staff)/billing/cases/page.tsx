import Link from "next/link";
import { Suspense } from "react";
import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listRevenueCases } from "@/data/revenue-cases";
import { CASE_DECISION_LABELS, CASE_KINDS, CASE_KIND_LABELS } from "@/lib/case-view";
import { formatWhen } from "@/lib/dates";
import { OpenCaseDialog } from "./open-case";

export const metadata = { title: "Revenue cases" };

// B-19: illegal consumption, terminated-but-consuming and unbilled accounts, and back-billing.
export default function CasesPage({ searchParams }: PageProps<"/billing/cases">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Cases searchParams={searchParams} />
    </Suspense>
  );
}

const one = (value: string | string[] | undefined) => (typeof value === "string" && value !== "" ? value : undefined);

async function Cases({ searchParams }: { searchParams: PageProps<"/billing/cases">["searchParams"] }) {
  const params = await searchParams;
  const data = await listRevenueCases({ status: one(params.status), kind: one(params.kind) });
  return (
    <>
      <PageHeader
        title="Revenue cases"
        description="Suspected lost revenue, kept as a log. Evidence is added, never edited, and a case ends with one decision. Back-billing posts a debit note, within a look-back limit and usually behind an approval."
        actions={data.canRun && <OpenCaseDialog />}
      />
      <ListFilters
        filters={[
          { param: "status", label: "Open and resolved", options: [{ value: "open", label: "Open" }, { value: "resolved", label: "Resolved" }] },
          { param: "kind", label: "Any kind", options: CASE_KINDS.map((k) => ({ value: k, label: CASE_KIND_LABELS[k] })) },
        ]}
      />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Case</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Opened</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.cases.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  No cases.{data.canRun ? " Open one when a field visit or a reconnection raises a suspicion." : ""}
                </TableCell>
              </TableRow>
            ) : (
              data.cases.map((c) => {
                const l = data.labels[c.accountId];
                return (
                  <TableRow key={c.id}>
                    <TableCell className="max-w-72">
                      <Link href={`/billing/cases/${c.id}`} className="truncate font-medium text-primary hover:underline">
                        {c.title}
                      </Link>
                    </TableCell>
                    <TableCell>{CASE_KIND_LABELS[c.kind]}</TableCell>
                    <TableCell>{l ? l.number : c.accountId.slice(0, 8)}</TableCell>
                    <TableCell>{c.status === "open" ? <Badge variant="warning">Open</Badge> : <Badge variant="outline">{c.decision ? CASE_DECISION_LABELS[c.decision] : "Resolved"}</Badge>}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatWhen(c.openedAt, data.locale, data.timeZone)}</TableCell>
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
