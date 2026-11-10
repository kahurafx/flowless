import { sql } from "drizzle-orm";
import { defineConsumer } from "../../kernel/events";
import { readSetting } from "../../kernel/config-store";
import { systemEnv } from "../../kernel/action-env";
import { defineJob } from "../../kernel/jobs";
import { readingRecorded } from "../metering";
import { billAccount, recordRunFailure } from "./bill-account";
import { BILL_ACCOUNT_JOB, enqueueAccountJob } from "./cycle-enqueue";
import { billingCycleSetting } from "./cycle-settings";
import { periodOfInstant } from "./run-input";
import { regionalSetting } from "../../kernel/regional";

/**
 * B-07: the job for one account of one cycle. Business holds (no baseline, outlier, flagged
 * reading ...) are recorded as cycle outcomes and the job finishes normally. An unexpected
 * error rolls the account's transaction back, then (in a fresh one) becomes an exception
 * outcome with the owner and an age (NF-24), and is rethrown so the runner retries with
 * backoff and, after the last attempt, raises its JOB_FAILURE as well. Siblings are separate
 * jobs and are never affected. A later success records a billed outcome, which resolves the
 * exception.
 */
export const billAccountJob = defineJob({
  ...BILL_ACCOUNT_JOB,
  module: "billing",
  label: "Billing run",
  async run(ctx, payload) {
    try {
      return await ctx.withTenant((tx) => billAccount(systemEnv(tx, ctx.organizationId), payload));
    } catch (error) {
      const message = (error as { cause?: { message?: string } })?.cause?.message ?? (error instanceof Error ? error.message : String(error));
      try {
        await ctx.withTenant((tx) => recordRunFailure(systemEnv(tx, ctx.organizationId), payload, message, ctx.attempt));
      } catch {
        // The cycle may be closed or the account unknown: the runner's own JOB_FAILURE still shows it.
      }
      throw error;
    }
  },
});

/**
 * B-01: with the trigger `on_reading` (setting and the cycle both), a clean routine reading
 * (cleared, so not flagged or blocked, and not an estimate) bills its account for the open
 * period through the same job. Flagged readings are left to the reading exceptions (M-05);
 * in batch mode this does nothing.
 */
export const billOnReading = defineConsumer({
  name: "billing.bill_on_reading",
  module: "billing",
  event: readingRecorded,
  async handle(ctx, e) {
    if (ctx.replay || !e.accountId || !e.cleared || e.source === "estimate" || e.purpose !== "routine") return;
    if ((await readSetting(ctx.tx, billingCycleSetting)).value.trigger !== "on_reading") return;
    const period = periodOfInstant(new Date(e.readAt), (await readSetting(ctx.tx, regionalSetting)).value.timeZone);
    const cycles = await ctx.tx.execute<{ id: string; opened_by: string | null }>(sql`
      select c.id, c.opened_by_user_id as opened_by
        from billing.cycle c
        join billing.cycle_account a on a.organization_id = c.organization_id and a.cycle_id = c.id
       where a.account_id = ${e.accountId} and a.expected and c.period = ${period} and c.trigger = 'on_reading' and c.state <> 'closed'`);
    const env = systemEnv(ctx.tx, ctx.organizationId);
    for (const c of cycles) await enqueueAccountJob(env, c.id, e.accountId, c.opened_by);
  },
});
