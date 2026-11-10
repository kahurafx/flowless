import type { Transaction } from "@flowless/db";
import { cycleAccount, cycleOutcome, document, documentLine } from "@flowless/db/schema/billing";
import type { CycleOutcomeKind } from "@flowless/db/schema/billing";
import { and, desc, eq, sql } from "drizzle-orm";
import type { ActionEnv } from "../../kernel/action-env";
import { readSetting } from "../../kernel/config-store";
import { loadEntitlements } from "../../kernel/entitlement-store";
import { raiseException } from "../../kernel/exception-store";
import { regionalSetting } from "../../kernel/regional";
import { chargesApplyingTo } from "../accounts";
import { attemptsFor, dispositionFor, readingsFor } from "../metering";
import { invoiceTypeIdByCode } from "../tariffs";
import type { BillAccountPayload } from "./cycle-enqueue";
import { cycleRow, recordOutcome } from "./cycles";
import { billHeld } from "./events";
import { monthEnd } from "./mapping";
import { lockAccount } from "./post";
import { analyseReadings, type RunReading } from "./run-input";
import { billingPolicySetting } from "./settings";
import { issueUsage, usageInputSchema, type UsageInput } from "./usage";

/*
 * One account of one cycle (B-07), run by the job `billing.bill_account` (`bill-job.ts`) and by
 * bill-on-reading (B-01). It builds the engine's input from published reads only (Accounts'
 * status and category, Metering's readings, visits and dispositions), posts through the same
 * `issueUsage` as the manual procedure, and records the cycle outcome. Idempotent: the bill's
 * key is `bill:<cycle>:<account>`, an account with a billed, estimated or excluded outcome is
 * left alone, and the account's lock makes concurrent runs take turns. An unexpected error
 * rolls this transaction back and is handled by the job (a visible exception, NF-24).
 */

export const billKey = (cycleId: string, accountId: string) => `bill:${cycleId}:${accountId}`;

export interface BillAccountResult {
  outcome: CycleOutcomeKind | "already_done" | "cycle_closed" | "not_expected";
  documentId?: string;
  reason?: string;
  flags?: string[];
}

const TERMINAL: readonly string[] = ["billed", "billed_estimate", "excluded"];

async function isEstimateDocument(tx: Transaction, documentId: string): Promise<boolean> {
  const rows = await tx
    .select({ position: documentLine.position })
    .from(documentLine)
    .where(and(eq(documentLine.documentId, documentId), sql`${documentLine.calculation}->>'code' = 'USAGE_EST'`))
    .limit(1);
  return rows.length > 0;
}

export async function billAccount(env: ActionEnv, payload: BillAccountPayload): Promise<BillAccountResult> {
  const { tx } = env;
  const { cycleId, accountId } = payload;
  await lockAccount(tx, accountId);
  const row = await cycleRow(tx, cycleId);
  const owner = payload.ownerUserId ?? row.openedByUserId;
  if (row.state === "closed") return { outcome: "cycle_closed" };
  const [member] = await tx.select().from(cycleAccount).where(and(eq(cycleAccount.cycleId, cycleId), eq(cycleAccount.accountId, accountId)));
  if (!member?.expected) return { outcome: "not_expected" };
  const [latest] = await tx.select({ outcome: cycleOutcome.outcome }).from(cycleOutcome).where(and(eq(cycleOutcome.cycleId, cycleId), eq(cycleOutcome.accountId, accountId))).orderBy(desc(cycleOutcome.seq)).limit(1);
  if (latest && TERMINAL.includes(latest.outcome)) return { outcome: "already_done" };

  const record = async (outcome: CycleOutcomeKind, extra: { reason?: string; documentId?: string; flagged?: boolean } = {}) => {
    const saved = await recordOutcome(env, { cycleId, accountId, outcome, flagged: extra.flagged ?? false, ...(extra.reason ? { reason: extra.reason.slice(0, 1000) } : {}), ...(extra.documentId ? { documentId: extra.documentId } : {}) }, owner);
    return saved;
  };
  const fail = async (reason: string, held?: { code: string; period: string }): Promise<BillAccountResult> => {
    const saved = await record("exception", { reason });
    if (held && saved.exceptionId) {
      await env.audit({ action: "billing.bill_held", subjectType: "account", subjectId: accountId, after: { period: held.period, code: held.code, message: reason, exceptionId: saved.exceptionId } });
      await env.publish(billHeld, { accountId, period: held.period, code: held.code, message: reason, exceptionId: saved.exceptionId });
    }
    return { outcome: "exception", reason };
  };

  const facts = await chargesApplyingTo(tx, accountId);
  if (!facts) return fail("The account does not exist");
  if (!facts.categoryId) return fail("The account has no tariff category");
  const policy = (await readSetting(tx, billingPolicySetting)).value;
  const invoiceTypeId = await invoiceTypeIdByCode(tx, env.organizationId, policy.usageInvoiceTypeCode);
  if (!invoiceTypeId) return fail(`No invoice type with code "${policy.usageInvoiceTypeCode}" (billing.policy usageInvoiceTypeCode)`);
  if (!(await loadEntitlements(tx)).includes("metering") || !member.servicePointId) {
    return fail("Metering is not licensed, so there are no readings to bill from; issue the bill by hand (invoices.issueUsage) and record the outcome");
  }

  const tz = (await readSetting(tx, regionalSetting)).value.timeZone;
  const views = await readingsFor(tx, { servicePointId: member.servicePointId, validOnly: true, actualOnly: true, limit: 200 });
  const readings: RunReading[] = views.map((v) => ({ id: v.id, meterId: v.meterId, value: v.value, readAt: v.readAt, recordedAt: v.recordedAt, purpose: v.purpose, kind: v.kind, status: v.status, cleared: v.cleared, rolloverConfirmed: v.rolloverConfirmed, replacesReadingId: v.replacesReadingId, dialDigits: v.dialDigits }));
  const { history, current } = analyseReadings(readings, row.period, tz);
  if (current.state === "pending") return fail("A reading for this period is flagged or awaiting approval; resolve it in the reading exceptions (M-05) and retry");
  if (current.state === "unresolved") return fail(current.reason);

  let dial: number | undefined;
  let rollover: boolean | undefined;
  let meterChange: UsageInput["meterChange"];
  let outcome: UsageInput["outcome"];
  let disposition: UsageInput["disposition"];
  if (current.state === "ready") {
    dial = current.dial;
    rollover = current.rollover || undefined;
    meterChange = current.meterChange;
  } else {
    // No reading for the period: a visit that found no dial decides by its disposition (M-06); no visit at all is estimated.
    const [visit] = await attemptsFor(tx, { servicePointId: member.servicePointId, cycleDate: row.cycleDate, limit: 1 });
    if (visit && visit.outcome !== "read_ok") {
      outcome = visit.outcome;
      disposition = await dispositionFor(tx, visit.outcome);
    }
  }

  const input: UsageInput = usageInputSchema.parse({
    idempotencyKey: billKey(cycleId, accountId),
    accountId,
    customerId: facts.customerId,
    categoryId: facts.categoryId,
    invoiceTypeId,
    servicePointId: member.servicePointId,
    period: row.period,
    reading: { ...(dial !== undefined ? { dial } : {}), ...(rollover ? { rollover } : {}) },
    readings: history.slice(-60),
    ...(meterChange ? { meterChange } : {}),
    ...(outcome ? { outcome } : {}),
    ...(disposition ? { disposition } : {}),
  });

  const result = await issueUsage(env, input, { quietHold: true });
  switch (result.outcome) {
    case "issued": {
      const estimate = result.estimate ?? (result.replayed && (await isEstimateDocument(tx, result.document.id)));
      const flags = result.flags ?? [];
      for (const f of flags) {
        await raiseException(tx, env.organizationId, {
          type: "READING_EXCEPTION",
          source: "billing",
          title: `Check the ${row.period} bill: ${f.code}`,
          detail: f.message,
          subject: { kind: "account", ref: accountId },
          routeId: row.routeId,
          ownerUserId: owner,
          dedupeKey: `billflag:${cycleId}:${accountId}:${f.code}`,
        });
      }
      await record(estimate ? "billed_estimate" : "billed", { documentId: result.document.id, flagged: flags.length > 0 });
      return { outcome: estimate ? "billed_estimate" : "billed", documentId: result.document.id, flags: flags.map((f) => f.code) };
    }
    case "held": {
      // The cycle's own exception below is the queue item; drop the generic held one issueUsage raised.
      if (result.code === "DUPLICATE_PERIOD") {
        const [doc] = await tx
          .select({ id: document.id })
          .from(document)
          .where(and(eq(document.accountId, accountId), eq(document.periodTo, monthEnd(row.period)), eq(document.kind, "invoice"), sql`not exists (select 1 from billing.document r where r.reverses_document_id = ${document.id})`))
          .limit(1);
        if (doc) {
          await record("billed", { documentId: doc.id });
          return { outcome: "billed", documentId: doc.id, reason: "Already billed for the period" };
        }
      }
      if (result.code === "STATUS_BLOCKED") {
        await record("excluded", { reason: result.message });
        return { outcome: "excluded", reason: result.message };
      }
      return fail(`${result.code}: ${result.message}`, { code: result.code, period: row.period });
    }
    case "skipped":
      await record("excluded", { reason: result.message });
      return { outcome: "excluded", reason: result.message };
    case "baseline":
      await record("excluded", { reason: "First reading set the baseline; the first bill follows the next reading" });
      return { outcome: "excluded", reason: "baseline" };
    default:
      await record("excluded", { reason: `Nothing to bill (${result.outcome})` });
      return { outcome: "excluded", reason: result.outcome };
  }
}

/** A failure the job caught: the account gets a visible exception outcome with the owner, in its own transaction. */
export async function recordRunFailure(env: ActionEnv, payload: BillAccountPayload, message: string, attempt: number): Promise<void> {
  const row = await cycleRow(env.tx, payload.cycleId);
  await recordOutcome(env, { cycleId: payload.cycleId, accountId: payload.accountId, outcome: "exception", flagged: false, reason: `Billing run failed (attempt ${attempt}): ${message}`.slice(0, 1000) }, payload.ownerUserId ?? row.openedByUserId);
}
