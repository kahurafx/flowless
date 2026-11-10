import { ArrowLeftIcon, ArrowRightIcon, CheckCircle2Icon, CircleAlertIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { ListFilters } from "@/components/list-filters";
import { MoneyText } from "@/components/money-text";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CYCLE_ACCOUNTS_PAGE, getBillingCycle, type CyclePage } from "@/data/billing-cycles";
import { asMoney } from "@/lib/billing-view";
import { formatWhen } from "@/lib/dates";
import { CYCLE_OUTCOMES, CYCLE_STATES, CYCLE_STATE_LABELS, FREQUENCY_LABELS, OUTCOME_LABELS, TRIGGER_LABELS, eligibilitySourceLabel, percentOf, periodLabel } from "@/lib/cycle-view";
import { CycleControls } from "./cycle-controls";
import { CycleReview, type ReviewRow } from "./cycle-review";

export const metadata = { title: "Billing cycle" };

export default function CyclePageRoute({ params, searchParams }: PageProps<"/billing/cycles/[id]">) {
  return (
    <>
      <Button variant="ghost" className="-ml-2.5 mb-2" render={<Link href="/billing/cycles" />}>
        <ArrowLeftIcon />
        Billing cycles
      </Button>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Cycle params={params} searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Cycle({ params, searchParams }: { params: PageProps<"/billing/cycles/[id]">["params"]; searchParams: PageProps<"/billing/cycles/[id]">["searchParams"] }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const outcome = typeof query.outcome === "string" ? query.outcome : undefined;
  const after = typeof query.after === "string" ? Number.parseInt(query.after, 10) : 0;
  const p = await getBillingCycle(id, { outcome, page: Number.isFinite(after) ? after : 0 });
  const { cycle } = p;
  const source = eligibilitySourceLabel(cycle.eligibilitySource);
  return (
    <>
      <PageHeader
        eyebrow={`${p.routeName} · ${FREQUENCY_LABELS[cycle.frequency]} · ${TRIGGER_LABELS[cycle.trigger]}`}
        title={periodLabel(cycle.period, p.locale)}
        description={
          <span>
            Cycle date {cycle.cycleDate}, opened by {p.openedBy}. Accounts from the <strong title={source.detail}>{source.label}</strong>
            {cycle.snapshotRows !== null ? ` (${cycle.snapshotRows} rows)` : ""}.
          </span>
        }
      />
      <div className="grid gap-6">
        <StateLine page={p} />
        <CycleControls cycleId={cycle.id} state={cycle.state} unexplained={cycle.completeness.unexplained} canRun={p.canRun} />
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Progress page={p} />
          <Completeness page={p} />
        </div>
        {p.queue && (
          <CycleReview
            cycleId={cycle.id}
            state={cycle.state}
            approved={p.queue.approved}
            held={p.queue.held}
            locale={p.locale}
            currency={p.currency}
            canRun={p.canRun}
            canApprove={p.canApprove}
            rows={p.queue.pending.map<ReviewRow>((r) => ({
              accountId: r.accountId,
              label: p.labels[r.accountId] ? `${p.labels[r.accountId]!.number} · ${p.labels[r.accountId]!.customerName}` : r.accountId.slice(0, 8),
              number: p.labels[r.accountId]?.number ?? null,
              bucket: r.bucket,
              amount: r.amount,
              flagged: r.flagged,
              review: r.review,
              documentId: r.documentId,
            }))}
          />
        )}
        <AccountsTable page={p} cycleId={id} />
        <History page={p} />
      </div>
    </>
  );
}

/** The cycle's place in the run: done, current, to come. */
function StateLine({ page: { cycle } }: { page: CyclePage }) {
  const at = CYCLE_STATES.indexOf(cycle.state);
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-sm" aria-label="Cycle state">
      {CYCLE_STATES.map((s, i) => (
        <li key={s} className="flex items-center gap-1.5">
          <Badge variant={i < at ? "success" : i === at ? "info" : "outline"} aria-current={i === at ? "step" : undefined}>
            {CYCLE_STATE_LABELS[s]}
          </Badge>
          {i < CYCLE_STATES.length - 1 && <ArrowRightIcon className="size-3.5 text-muted-foreground" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

function Progress({ page: { progress, labels } }: { page: CyclePage }) {
  const tiles: { key: keyof typeof progress.byOutcome; label: string }[] = [
    { key: "billed", label: OUTCOME_LABELS.billed },
    { key: "billed_estimate", label: OUTCOME_LABELS.billed_estimate },
    { key: "exception", label: OUTCOME_LABELS.exception },
    { key: "excluded", label: OUTCOME_LABELS.excluded },
    { key: "none", label: OUTCOME_LABELS.none },
  ];
  const total = progress.jobs.queued + progress.jobs.running + progress.jobs.done + progress.jobs.failed;
  return (
    <section aria-labelledby="progress-title" className="rounded-xl border bg-card p-4">
      <h2 id="progress-title" className="font-semibold">
        Progress
      </h2>
      <p className="mb-3 text-sm text-muted-foreground">
        {progress.done} of {progress.expected} expected accounts have an outcome ({percentOf(progress.done, progress.expected)}%).
        {progress.flagged > 0 ? ` ${progress.flagged} flagged for review.` : ""}
      </p>
      <progress className="mb-3 h-2 w-full" value={progress.done} max={Math.max(progress.expected, 1)} aria-label="Accounts with an outcome" />
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {tiles.map((t) => (
          <div key={t.key} className="rounded-lg border p-2">
            <dt className="text-xs text-muted-foreground">{t.label}</dt>
            <dd className="text-lg font-semibold tabular">{progress.byOutcome[t.key]}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-sm">
        Jobs: <span className="tabular">{progress.jobs.queued}</span> queued, <span className="tabular">{progress.jobs.running}</span> running, <span className="tabular">{progress.jobs.done}</span> done,{" "}
        <span className={progress.jobs.failed > 0 ? "font-medium text-destructive tabular" : "tabular"}>{progress.jobs.failed}</span> failed{total === 0 ? " (none queued yet)" : ""}.
      </p>
      {progress.failures.length > 0 && (
        <div className="mt-3">
          <h3 className="mb-1 text-sm font-medium">Failures and exceptions</h3>
          <ul className="grid gap-1.5 text-sm">
            {progress.failures.map((f) => (
              <li key={f.accountId} className="flex flex-wrap gap-x-2">
                <span className="font-medium">{labels[f.accountId]?.number ?? f.accountId.slice(0, 8)}</span>
                <span className="text-muted-foreground">{f.reason ?? "No reason recorded"}</span>
                {f.exceptionId && (
                  <Link href="/exceptions" className="text-primary hover:underline">
                    Exception queue
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Completeness({ page: { cycle, labels } }: { page: CyclePage }) {
  const c = cycle.completeness;
  return (
    <section aria-labelledby="completeness-title" className="rounded-xl border bg-card p-4">
      <h2 id="completeness-title" className="flex items-center gap-2 font-semibold">
        {c.complete ? <CheckCircle2Icon className="size-4 text-success" aria-hidden /> : <CircleAlertIcon className="size-4 text-warning" aria-hidden />}
        Completeness
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {c.complete
          ? `Every one of the ${c.expected} expected accounts is explained. The cycle can close from the completeness check.`
          : `${c.unexplained} of ${c.expected} expected accounts are unexplained, so the cycle cannot close. ${c.explained} are explained.`}
      </p>
      {c.examples.length > 0 && (
        <ul className="mt-3 grid gap-1 text-sm">
          {c.examples.map((e) => (
            <li key={e.accountId}>
              <span className="font-medium">{labels[e.accountId] ? `${labels[e.accountId]!.number} · ${labels[e.accountId]!.customerName}` : e.accountId.slice(0, 8)}</span> <span className="text-muted-foreground">{e.problem}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AccountsTable({ page: p, cycleId }: { page: CyclePage; cycleId: string }) {
  const { rows, total } = p.accounts;
  const from = p.page * CYCLE_ACCOUNTS_PAGE;
  const link = (n: number) => `/billing/cycles/${cycleId}?${new URLSearchParams({ ...(p.outcome ? { outcome: p.outcome } : {}), after: String(n) }).toString()}`;
  return (
    <section aria-labelledby="accounts-title">
      <h2 id="accounts-title" className="mb-2 font-semibold">
        Accounts
      </h2>
      <ListFilters
        filters={[{ param: "outcome", label: "Any outcome", options: [...CYCLE_OUTCOMES, "none" as const].map((o) => ({ value: o, label: OUTCOME_LABELS[o] })) }]}
      />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Account</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead className="text-right">Billed</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                  {p.outcome ? "No accounts with that outcome." : "No accounts in this cycle."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const l = p.labels[r.accountId];
                return (
                  <TableRow key={r.accountId}>
                    <TableCell>{l ? <Link href={`/accounts/${encodeURIComponent(l.number)}`} className="text-primary hover:underline">{l.number} · {l.customerName}</Link> : r.accountId.slice(0, 8)}</TableCell>
                    <TableCell>{r.expected ? "Yes" : <span className="text-muted-foreground">No: {r.snapshotReason.replace(/_/g, " ")}</span>}</TableCell>
                    <TableCell>
                      {r.outcome ? <Badge variant={r.outcome === "exception" ? "destructive" : r.outcome === "excluded" ? "outline" : "success"}>{OUTCOME_LABELS[r.outcome]}</Badge> : r.expected ? <span className="text-muted-foreground">None yet</span> : "-"}
                      {r.flagged && <Badge variant="warning" className="ml-1.5">Flagged</Badge>}
                      {r.review === "approve" && <Badge variant="outline" className="ml-1.5">Approved</Badge>}
                      {r.review === "hold" && <Badge variant="warning" className="ml-1.5">Held</Badge>}
                    </TableCell>
                    <TableCell className="text-right">{r.amount !== null ? <MoneyText value={asMoney(r.amount, p.currency)} locale={p.locale} /> : "-"}</TableCell>
                    <TableCell className="max-w-80 truncate text-muted-foreground" title={r.reason ?? undefined}>{r.reason ?? ""}</TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {total === 0 ? "0" : `${from + 1} to ${from + rows.length}`} of {total}
        </span>
        <span className="flex gap-2">
          {p.page > 0 && (
            <Button variant="outline" render={<Link href={link(p.page - 1)} />}>
              Previous
            </Button>
          )}
          {from + rows.length < total && (
            <Button variant="outline" render={<Link href={link(p.page + 1)} />}>
              Next page
            </Button>
          )}
        </span>
      </div>
    </section>
  );
}

function History({ page: p }: { page: CyclePage }) {
  return (
    <details className="rounded-xl border bg-card p-4">
      <summary className="cursor-pointer text-sm font-medium">State log ({p.cycle.events.length})</summary>
      <ol className="mt-3 grid gap-2 text-sm">
        {p.cycle.events.map((e) => (
          <li key={e.id}>
            <span className="font-medium">{e.to ? CYCLE_STATE_LABELS[e.to] : ""}</span> <span className="text-muted-foreground">({e.kind})</span>
            <span className="block text-xs text-muted-foreground">
              {p.eventActors[e.id]} · {formatWhen(e.at, p.locale, p.timeZone)}
              {e.reason ? ` · ${e.reason}` : ""}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}
