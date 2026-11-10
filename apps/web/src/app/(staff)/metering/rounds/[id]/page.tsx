import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getRound } from "@/data/metering";
import { formatWhen } from "@/lib/dates";
import { ELIGIBILITY_LABELS, TASK_STATE_LABELS } from "@/lib/metering-view";
import { DISPOSITION_LABELS, OUTCOME_FIELD_LABELS } from "@/lib/policy-settings";

export const metadata = { title: "Reading round" };

export default function RoundPageRoute({ params }: PageProps<"/metering/rounds/[id]">) {
  return (
    <>
      <Button variant="ghost" className="-ml-2.5 mb-2" render={<Link href="/metering/rounds" />}>
        <ArrowLeftIcon />
        Reading rounds
      </Button>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Round params={params} />
      </Suspense>
    </>
  );
}

async function Round({ params }: { params: PageProps<"/metering/rounds/[id]">["params"] }) {
  const { id } = await params;
  const p = await getRound(id);
  const eligible = p.snapshot.rows.filter((r) => r.eligible).length;
  const counts = { to_read: 0, read: 0, missed: 0 };
  for (const t of Object.values(p.tasks)) counts[t.state] += 1;
  return (
    <>
      <PageHeader
        eyebrow={p.routeName}
        title={`Cycle date ${p.snapshot.cycleDate}`}
        description={`Taken ${formatWhen(p.snapshot.takenAt, p.locale, p.timeZone)} by ${p.takenBy}. ${eligible} of ${p.snapshot.rows.length} service points are eligible: ${counts.to_read} to read, ${counts.read} read, ${counts.missed} missed. The walking sequence is not available yet.`}
      />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Account</TableHead>
              <TableHead>Meter</TableHead>
              <TableHead>Eligibility</TableHead>
              <TableHead>Reading task</TableHead>
              <TableHead>Last visit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {p.snapshot.rows.map((r) => {
              const l = p.labels[r.accountId];
              const task = p.tasks[r.servicePointId];
              return (
                <TableRow key={r.servicePointId}>
                  <TableCell>{l ? <Link href={`/accounts/${encodeURIComponent(l.number)}`} className="text-primary hover:underline">{l.number} · {l.customerName}</Link> : r.accountId.slice(0, 8)}</TableCell>
                  <TableCell>{r.meterId ? (p.meters[r.meterId] ?? r.meterId.slice(0, 8)) : <span className="text-muted-foreground">None</span>}</TableCell>
                  <TableCell>{r.eligible ? <Badge variant="success">{ELIGIBILITY_LABELS.eligible}</Badge> : <Badge variant="outline">{ELIGIBILITY_LABELS[r.reason]}</Badge>}</TableCell>
                  <TableCell>{task ? <Badge variant={task.state === "read" ? "success" : task.state === "missed" ? "warning" : "secondary"}>{TASK_STATE_LABELS[task.state]}</Badge> : "-"}</TableCell>
                  <TableCell className="text-muted-foreground">{task?.outcome ? `${OUTCOME_FIELD_LABELS[task.outcome]}${task.disposition ? ` → ${DISPOSITION_LABELS[task.disposition]}` : ""}` : "-"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
