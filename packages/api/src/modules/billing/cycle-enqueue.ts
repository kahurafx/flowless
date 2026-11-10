import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ActionEnv } from "../../kernel/action-env";
import { loadEntitlements } from "../../kernel/entitlement-store";
import { enqueueJobs } from "../../kernel/jobs";
import { attemptsFor } from "../metering";

/*
 * Queues the per-account billing jobs of a cycle (B-07). One job per expected account, with a
 * deterministic key `bill:<cycle>:<account>:<n>` where n is how many outcomes the account has
 * already had, so queueing a cycle twice queues nothing new, while a retry after a recorded
 * failure (n = 1) is a fresh job. The job's definition lives in `bill-job.ts`; only its
 * type, payload and attempts are needed here, which keeps this file free of the cycle code.
 */

export const billAccountPayload = z.object({
  cycleId: z.uuid(),
  accountId: z.uuid(),
  /** Who owns the exceptions the job raises (NF-24); the cycle's opener when absent. */
  ownerUserId: z.uuid().nullable().optional(),
});
export type BillAccountPayload = z.infer<typeof billAccountPayload>;

export const BILL_ACCOUNT_JOB = { type: "billing.bill_account", schema: billAccountPayload, maxAttempts: 3 } as const;

export const billJobKey = (cycleId: string, accountId: string, n: number) => `bill:${cycleId}:${accountId}:${n}`;

/**
 * - `pending`: expected accounts with no outcome yet (calculation, and `cycles.run`).
 * - `retry`: the same plus accounts whose newest outcome is an exception (`cycles.retry`).
 * - `missed`: pending accounts whose newest visit for the cycle date found no dial (estimation).
 * Accounts with a billed, estimated or excluded outcome are never queued again.
 */
export type EnqueueMode = "pending" | "retry" | "missed";

export async function enqueueCycleJobs(env: ActionEnv, cycleId: string, mode: EnqueueMode, ownerUserId: string | null = env.actor.userId): Promise<{ enqueued: number; candidates: number }> {
  const { tx } = env;
  const retry = mode === "retry";
  const rows = await tx.execute<{ account_id: string; n: number }>(sql`
    select a.account_id, o.n::int as n
      from billing.cycle_account a
      left join lateral (
        select count(*) as n, (array_agg(x.outcome order by x.seq desc))[1] as latest
          from billing.cycle_outcome x
         where x.organization_id = a.organization_id and x.cycle_id = a.cycle_id and x.account_id = a.account_id) o on true
     where a.cycle_id = ${cycleId} and a.expected
       and (o.latest is null or (${retry} and o.latest = 'exception'))
     order by a.account_id`);
  let candidates = [...rows];
  if (mode === "missed") {
    const missed = await missedAccounts(env, cycleId);
    candidates = candidates.filter((r) => missed.has(r.account_id));
  }
  const enqueued = await enqueueJobs(
    tx,
    env.organizationId,
    BILL_ACCOUNT_JOB,
    candidates.map((r) => ({ payload: { cycleId, accountId: r.account_id, ownerUserId }, idempotencyKey: billJobKey(cycleId, r.account_id, r.n) })),
    { createdByUserId: ownerUserId },
  );
  return { enqueued, candidates: candidates.length };
}

/** Accounts whose newest visit for the cycle date was not a successful read (M-06); empty when Metering is not licensed. */
async function missedAccounts(env: ActionEnv, cycleId: string): Promise<Set<string>> {
  const { tx } = env;
  if (!(await loadEntitlements(tx)).includes("metering")) return new Set();
  const [cycle] = await tx.execute<{ cycle_date: string }>(sql`select cycle_date::text as cycle_date from billing.cycle where id = ${cycleId}`);
  if (!cycle) return new Set();
  const visits = await attemptsFor(tx, { cycleDate: cycle.cycle_date, limit: 1_000_000 });
  const seen = new Set<string>();
  const missed = new Set<string>();
  for (const v of visits) {
    if (!v.accountId || seen.has(v.accountId)) continue;
    seen.add(v.accountId);
    if (v.outcome !== "read_ok") missed.add(v.accountId);
  }
  return missed;
}

/** Queues one account (bill-on-reading, B-01); nothing when it already has a terminal outcome or a job for this attempt. */
export async function enqueueAccountJob(env: ActionEnv, cycleId: string, accountId: string, ownerUserId: string | null): Promise<boolean> {
  const [state] = await env.tx.execute<{ n: number; latest: string | null }>(sql`
    select count(*)::int as n, (array_agg(outcome order by seq desc))[1] as latest
      from billing.cycle_outcome where cycle_id = ${cycleId} and account_id = ${accountId}`);
  if (state?.latest && state.latest !== "exception") return false;
  const queued = await enqueueJobs(env.tx, env.organizationId, BILL_ACCOUNT_JOB, [{ payload: { cycleId, accountId, ownerUserId }, idempotencyKey: billJobKey(cycleId, accountId, state?.n ?? 0) }], { createdByUserId: ownerUserId });
  return queued > 0;
}
