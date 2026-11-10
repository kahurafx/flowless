import type { Transaction } from "@flowless/db";
import { sql } from "drizzle-orm";
import { readSetting } from "../../kernel/config-store";
import { defineConsumer } from "../../kernel/events";
import { raiseException } from "../../kernel/exception-store";
import { regionalSetting } from "../../kernel/regional";
import { readingById, readingRecorded, readingStatusChanged } from "../metering";
import { exceptionKey } from "./corrections";
import { monthEnd, monthStart } from "./mapping";
import { periodOfInstant } from "./run-input";

/*
 * B-14, M-11: Metering tells Billing about a reading that changes what a past period should
 * have cost. Billing raises a visible "correction needed" exception (owner: the team queue,
 * age from the raise time, one per account and period) that `corrections.post` resolves. It
 * never posts a correction by itself: who may do that depends on the grace window and the
 * evidence (`correction-policy.ts`).
 *
 * Triggers: a routine reading recorded with the CLOSED_PERIOD flag (a late reading), a
 * correction of a reading (it supersedes the old one) whose period was billed, and a billed
 * reading voided.
 */

/** Was the period billed (a live invoice that ends in it)? */
export async function periodBilled(tx: Transaction, accountId: string, period: string): Promise<boolean> {
  const rows = await tx.execute<{ n: string }>(sql`
    select count(*)::text as n from billing.document d
     where d.account_id = ${accountId} and d.kind = 'invoice'
       and d.period_to between ${monthStart(period)} and ${monthEnd(period)}
       and not exists (select 1 from billing.document r where r.reverses_document_id = d.id)`);
  return Number(rows[0]?.n ?? 0) > 0;
}

async function raiseNeeded(tx: Transaction, organizationId: string, accountId: string, period: string, why: string) {
  await raiseException(tx, organizationId, {
    type: "CORRECTION_NEEDED",
    source: "billing",
    title: `Correction needed for ${period}`,
    detail: `${why}. Preview it with billing.corrections.preview and post it with corrections.post.`,
    subject: { kind: "account", ref: accountId },
    dedupeKey: exceptionKey(accountId, period),
  });
}

export const correctionNeededOnRecorded = defineConsumer({
  name: "billing.correction_needed_on_reading",
  module: "billing",
  event: readingRecorded,
  async handle(ctx, e) {
    if (ctx.replay || !e.accountId || e.purpose !== "routine" || e.source === "estimate") return;
    const period = periodOfInstant(new Date(e.readAt), (await readSetting(ctx.tx, regionalSetting)).value.timeZone);
    if (e.flags.includes("CLOSED_PERIOD")) {
      await raiseNeeded(ctx.tx, ctx.organizationId, e.accountId, period, `A reading dated ${e.readAt.slice(0, 10)} arrived for a closed period`);
    } else if (e.replacesReadingId && (await periodBilled(ctx.tx, e.accountId, period))) {
      await raiseNeeded(ctx.tx, ctx.organizationId, e.accountId, period, `A reading of ${period} that was already billed was corrected`);
    }
  },
});

export const correctionNeededOnStatus = defineConsumer({
  name: "billing.correction_needed_on_void",
  module: "billing",
  event: readingStatusChanged,
  async handle(ctx, e) {
    if (ctx.replay || !e.accountId || e.status !== "voided") return;
    const reading = await readingById(ctx.tx, e.readingId);
    if (!reading || reading.purpose !== "routine" || reading.kind === "estimate") return;
    const period = periodOfInstant(reading.readAt, (await readSetting(ctx.tx, regionalSetting)).value.timeZone);
    if (await periodBilled(ctx.tx, e.accountId, period)) {
      await raiseNeeded(ctx.tx, ctx.organizationId, e.accountId, period, `A reading of ${period} that was already billed was voided`);
    }
  },
});
