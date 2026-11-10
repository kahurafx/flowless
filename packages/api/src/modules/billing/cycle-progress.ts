import type { Transaction } from "@flowless/db";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import type { UserActionEnv } from "../../kernel/action-env";
import { BILL_ACCOUNT_JOB, enqueueCycleJobs } from "./cycle-enqueue";
import { cycleRow } from "./cycles";

/*
 * Resuming a run and watching it (B-07). `run` queues every expected account without an
 * outcome, `retry` also the ones whose newest outcome is an exception; both are safe to
 * repeat (deterministic job keys). `progress` is the UI's read: outcomes by kind, the jobs
 * still in the queue, and what failed with the reason.
 */

export async function runCycle(env: UserActionEnv, cycleId: string, retry: boolean) {
  const row = await cycleRow(env.tx, cycleId, true);
  if (row.state === "closed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The cycle is closed; correct periods with notes or a re-bill (B-14)" });
  if (!["estimation", "calculation", "review", "issue", "deliver", "completeness"].includes(row.state) && !(row.trigger === "on_reading")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Bills are calculated from the calculation state (this cycle is in ${row.state})` });
  }
  const queued = await enqueueCycleJobs(env, cycleId, retry ? "retry" : "pending");
  await env.audit({ action: retry ? "billing.cycle_retry" : "billing.cycle_run", subjectType: "billing_cycle", subjectId: cycleId, after: queued });
  return queued;
}

export async function cycleProgress(tx: Transaction, cycleId: string) {
  const row = await cycleRow(tx, cycleId);
  const [counts] = await tx.execute<Record<string, string>>(sql`
    select count(*)::text as expected,
           count(*) filter (where o.outcome = 'billed')::text as billed,
           count(*) filter (where o.outcome = 'billed_estimate')::text as billed_estimate,
           count(*) filter (where o.outcome = 'exception')::text as exception,
           count(*) filter (where o.outcome = 'excluded')::text as excluded,
           count(*) filter (where o.outcome is null)::text as none,
           count(*) filter (where o.flagged)::text as flagged
      from billing.cycle_account a
      left join lateral (
        select x.outcome, x.flagged from billing.cycle_outcome x
         where x.organization_id = a.organization_id and x.cycle_id = a.cycle_id and x.account_id = a.account_id
         order by x.seq desc limit 1) o on true
     where a.cycle_id = ${cycleId} and a.expected`);
  const jobRows = await tx.execute<{ status: string; n: string }>(sql`
    select status, count(*)::text as n from kernel.job
     where type = ${BILL_ACCOUNT_JOB.type} and idempotency_key like ${`bill:${cycleId}:%`}
     group by status`);
  const jobs = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const j of jobRows) if (j.status in jobs) jobs[j.status as keyof typeof jobs] = Number(j.n);
  const failures = await tx.execute<{ account_id: string; reason: string | null; exception_id: string | null; at: Date }>(sql`
    select a.account_id, o.reason, o.exception_id, o.created_at as at
      from billing.cycle_account a
      join lateral (
        select x.* from billing.cycle_outcome x
         where x.organization_id = a.organization_id and x.cycle_id = a.cycle_id and x.account_id = a.account_id
         order by x.seq desc limit 1) o on true
     where a.cycle_id = ${cycleId} and a.expected and o.outcome = 'exception'
     order by o.created_at, a.account_id limit 50`);
  const n = (k: string) => Number(counts?.[k] ?? 0);
  const done = n("expected") - n("none");
  return {
    cycleId,
    state: row.state,
    expected: n("expected"),
    done,
    percent: n("expected") === 0 ? 100 : Math.floor((done * 100) / n("expected")),
    byOutcome: { billed: n("billed"), billed_estimate: n("billed_estimate"), exception: n("exception"), excluded: n("excluded"), none: n("none") },
    flagged: n("flagged"),
    jobs,
    failures: failures.map((f) => ({ accountId: f.account_id, reason: f.reason, exceptionId: f.exception_id, at: f.at })),
  };
}
