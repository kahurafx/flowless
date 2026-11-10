import { reconnect as engineReconnect, newAccount } from "@flowless/billing-engine";
import { document, documentLine } from "@flowless/db/schema/billing";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { UserActionEnv } from "../../kernel/action-env";
import { readSetting } from "../../kernel/config-store";
import { loadEntitlements } from "../../kernel/entitlement-store";
import { regionalSetting } from "../../kernel/regional";
import { chargesApplyingTo, runStatusCommand, servicePointsOf, type Viewer } from "../accounts";
import { currentMeterOf, readingsFor, recordFinalReading } from "../metering";
import { invoiceTypeIdByCode } from "../tariffs";
import { openCase, type CaseView } from "./cases";
import { finalInputSchema, issueFinal } from "./final";
import { lockAccount } from "./post";
import { analyseReadings, periodOfInstant, type RunReading } from "./run-input";
import { billingPolicySetting } from "./settings";
import { readingFactSchema, todayOf } from "./usage";

/*
 * Disconnection and reconnection (B-12, B-19). One command each:
 *
 * `disconnect` (keyed by a client-minted disconnection id): the mandatory final reading goes to
 * Metering for a metered account, the final bill (the month in full plus the turn-off fee)
 * posts once, then Accounts' `disconnect_service` command runs as the actor. Every step is
 * idempotent on the same id (reading id and bill key derive from it, the Accounts command takes
 * it), so a retry repeats nothing; any refusal rolls the whole transaction back, so there is
 * never a half-done disconnection. Charges after it follow Accounts' status table (C-04).
 *
 * `reconnect`: billing restarts from the final reading. No reading is stored (so an account
 * cannot hold two different readings in a month). The engine compares the dial found with the
 * final one; a moved dial (up, or down) still reconnects but opens an illegal-consumption case
 * and its exception. The units that moved are not billed here: the next reading's span covers
 * them.
 */

/** A stable uuid from the disconnection event id, for the reading and the case. */
export function derivedId(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const refuse = (message: string, code: "PRECONDITION_FAILED" | "BAD_REQUEST" | "NOT_FOUND" = "PRECONDITION_FAILED") => new TRPCError({ code, message });

export const disconnectInput = z.object({
  /** The disconnection event's id, minted by the client: one final bill, one reading, one status command. */
  id: z.uuid(),
  accountId: z.uuid(),
  servicePointId: z.uuid().optional(),
  /** The final dial. Required for a metered account (B-12) and when Metering is not licensed. */
  dial: z.number().int().min(0).optional(),
  rollover: z.boolean().optional(),
  /** When the final reading was taken (default now). */
  readAt: z.date().optional(),
  reason: z.string().trim().min(1, "Say why").max(500),
  reasonCode: z.string().trim().min(1).max(40).optional(),
  note: z.string().trim().max(2000).optional(),
  turnOffFeeChargeItemId: z.uuid().optional(),
  /** Defaults to the usage invoice type of `billing.policy`. */
  invoiceTypeId: z.uuid().optional(),
  /** Reading history, only when Metering is not licensed or the account has no meter. */
  readings: z.array(readingFactSchema).max(60).default([]),
});

export async function disconnect(env: UserActionEnv, viewer: Viewer, input: z.infer<typeof disconnectInput>) {
  const { tx } = env;
  await lockAccount(tx, input.accountId);
  const facts = await chargesApplyingTo(tx, input.accountId);
  if (!facts) throw refuse("Account not found", "NOT_FOUND");
  if (!facts.categoryId) throw refuse("The account has no tariff category");
  const policy = (await readSetting(tx, billingPolicySetting)).value;
  const invoiceTypeId = input.invoiceTypeId ?? (await invoiceTypeIdByCode(tx, env.organizationId, policy.usageInvoiceTypeCode));
  if (!invoiceTypeId) throw refuse(`No invoice type with code "${policy.usageInvoiceTypeCode}" (billing.policy usageInvoiceTypeCode)`);

  const tz = (await readSetting(tx, regionalSetting)).value.timeZone;
  const metering = (await loadEntitlements(tx)).includes("metering");
  const points = await servicePointsOf(tx, input.accountId);
  const point = input.servicePointId ? points.find((p) => p.servicePointId === input.servicePointId) : points[0];
  if (input.servicePointId && !point) throw refuse("That service point does not belong to the account", "NOT_FOUND");
  const meter = metering && point ? await currentMeterOf(tx, point.servicePointId) : null;
  const readAt = input.readAt ?? new Date();
  const period = periodOfInstant(readAt, tz);

  if (input.dial === undefined) {
    throw refuse(meter ? "A metered account needs its final reading to be disconnected (B-12)" : "Give the final dial reading", "BAD_REQUEST");
  }

  let readings = input.readings;
  let finalReadingId: string | null = null;
  if (meter && point) {
    const recorded = await recordFinalReading(env, { id: derivedId(`final-reading:${input.id}`), meterId: meter.meterId, value: input.dial, readAt, ...(input.rollover !== undefined ? { rolloverConfirmed: input.rollover } : {}) });
    if (!recorded.reading.cleared) {
      throw refuse(`The final reading was refused: ${recorded.reading.flags.join(", ") || "flagged"}. Check the dial, or confirm a rollover, and send it again.`);
    }
    finalReadingId = recorded.reading.id;
    const views = await readingsFor(tx, { servicePointId: point.servicePointId, validOnly: true, actualOnly: true, limit: 200 });
    const run: RunReading[] = views.map((v) => ({ id: v.id, meterId: v.meterId, value: v.value, readAt: v.readAt, recordedAt: v.recordedAt, purpose: v.purpose, kind: v.kind, status: v.status, cleared: v.cleared, rolloverConfirmed: v.rolloverConfirmed, replacesReadingId: v.replacesReadingId, dialDigits: v.dialDigits }));
    readings = analyseReadings(run, period, tz).history.slice(-60).map((h) => ({ period: h.period, kind: "actual" as const, dial: h.dial, ...(h.units !== undefined ? { units: h.units } : {}), ...(h.months !== undefined ? { months: h.months } : {}), flags: h.flags }));
  }

  const bill = await issueFinal(
    env,
    finalInputSchema.parse({
      eventKey: input.id,
      accountId: input.accountId,
      customerId: facts.customerId,
      categoryId: facts.categoryId,
      invoiceTypeId,
      ...(point ? { servicePointId: point.servicePointId } : {}),
      period,
      dial: input.dial,
      ...(input.rollover !== undefined ? { rollover: input.rollover } : {}),
      readings,
      ...(input.turnOffFeeChargeItemId ? { turnOffFeeChargeItemId: input.turnOffFeeChargeItemId } : {}),
    }),
  );
  if (bill.outcome === "held") throw refuse(`The final bill is held (${bill.code}): ${bill.message}`);
  if (bill.outcome === "skipped" || bill.outcome === "duplicate" || bill.outcome === "none") throw refuse("The final bill could not be made for this period");
  // `baseline`: the account has no earlier reading, so the final dial only set the baseline and nothing is billed.

  const result = await runStatusCommand(env, viewer, {
    id: input.id,
    accountId: input.accountId,
    kind: "disconnect_service",
    reason: input.reason,
    reasonCode: input.reasonCode,
    note: input.note,
  });
  return {
    replayed: result.replayed,
    finalReadingId,
    finalBill: bill.outcome === "issued" ? bill.document : null,
    finalBillOutcome: bill.outcome,
    account: result.account,
  };
}

export const reconnectInput = z.object({
  /** The reconnection event's id, minted by the client. */
  id: z.uuid(),
  accountId: z.uuid(),
  /** The dial found at reconnection. */
  dial: z.number().int().min(0),
  reason: z.string().trim().min(1, "Say why").max(500),
  reasonCode: z.string().trim().min(1).max(40).optional(),
  note: z.string().trim().max(2000).optional(),
});

export async function reconnect(env: UserActionEnv, viewer: Viewer, input: z.infer<typeof reconnectInput>) {
  const { tx } = env;
  await lockAccount(tx, input.accountId);
  const facts = await chargesApplyingTo(tx, input.accountId);
  if (!facts) throw refuse("Account not found", "NOT_FOUND");

  // The final bill to restart from: the newest live one, with the dial it recorded.
  const [finalDoc] = await tx
    .select({ id: document.id, periodTo: document.periodTo })
    .from(document)
    .where(and(eq(document.accountId, input.accountId), eq(document.finalBill, true), sql`not exists (select 1 from billing.document r where r.reverses_document_id = ${document.id})`))
    .orderBy(desc(document.createdAt))
    .limit(1);
  if (!finalDoc?.periodTo) throw refuse("There is no final bill with a final reading on file for this account; reconnect it through accounts.reconnectService");
  const lines = await tx.select({ calculation: documentLine.calculation }).from(documentLine).where(eq(documentLine.documentId, finalDoc.id));
  const finalDial = lines.map((l) => (l.calculation as { finalDial?: number } | null)?.finalDial).find((d) => typeof d === "number");
  if (finalDial === undefined) throw refuse("The final bill does not record its final reading; reconnect it through accounts.reconnectService");

  const finalPeriod = finalDoc.periodTo.slice(0, 7);
  const engine = {
    ...newAccount({ status: "DISCONNECTED" }),
    readings: [{ id: 1, period: finalPeriod, kind: "actual" as const, dial: finalDial, voided: false, flags: [] }],
    docs: [{ id: 2, period: finalPeriod, type: "invoice" as const, lines: [], total: 0n, readingId: 1, final: true, voided: false }],
    seq: 2,
  };
  const { outcome } = engineReconnect(engine, (await todayOf(tx)).slice(0, 7), { dial: input.dial, key: input.id });
  if (outcome.kind === "held") throw refuse(`${outcome.exception.code}: ${outcome.exception.message}`);

  let revenueCase: CaseView | null = null;
  if (outcome.kind === "suspected_illegal_consumption") {
    const points = await servicePointsOf(tx, input.accountId);
    const opened = await openCase(env, {
      id: derivedId(`reconnect-case:${input.id}`),
      kind: "illegal_consumption",
      accountId: input.accountId,
      ...(points[0] ? { servicePointId: points[0].servicePointId } : {}),
      title: `Suspected illegal consumption at reconnection of ${facts.number}`,
      detail: outcome.exception.message + (outcome.movedBy < 0 ? " The dial is lower than at disconnection (tampering or a misread)." : ""),
      data: { finalDial, foundDial: input.dial, movedBy: outcome.movedBy, finalPeriod, reconnectionId: input.id },
    });
    revenueCase = opened.case;
  }

  const result = await runStatusCommand(env, viewer, {
    id: input.id,
    accountId: input.accountId,
    kind: "reconnect_service",
    reason: input.reason,
    reasonCode: input.reasonCode,
    note: input.note,
  });
  return {
    replayed: result.replayed,
    outcome: outcome.kind === "reconnected" ? ("reconnected" as const) : ("reconnected_suspected_illegal_consumption" as const),
    movedBy: outcome.kind === "suspected_illegal_consumption" ? outcome.movedBy : 0,
    finalDial,
    case: revenueCase,
    account: result.account,
  };
}
