import { billReading, newAccount, periodFromIndex, periodIndex, type Reading } from "@flowless/billing-engine";
import { organizationSettings, type Transaction } from "@flowless/db";
import { document, documentLine } from "@flowless/db/schema/billing";
import { bandsFor } from "@flowless/shared-types";
import { todayIn } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import type { ActionEnv, UserActionEnv } from "../../kernel/action-env";
import { readSetting } from "../../kernel/config-store";
import { raiseException } from "../../kernel/exception-store";
import { regionalSetting } from "../../kernel/regional";
import { categoryPricing, chargeItemAmountInForce, tariffVersionInForce } from "../tariffs";
import { billHeld, documentIssued } from "./events";
import { engineDocsFrom, engineTariffs, linesFromEngineDoc, monthStart, type PricedMonth, type StoredDocument } from "./mapping";
import { documentByKey, lockAccount, postDraft, linesOf, type Dimensions, type Draft } from "./post";
import { documentFacts, toDocumentDto, toLineDto } from "./present";
import { billingPolicySetting } from "./settings";
import { plain } from "../../kernel/text";

/*
 * Issue a usage bill (B-05, B-06, B-08 to B-11, T-04, T-05). Metering and billing runs are
 * Phase 5, so the caller states the facts the engine needs: the account's category, the
 * period, the reading (a dial or an estimate) and the reading history. Tariffs come from
 * Tariffs' published reads; the engine prices; this file maps the result onto documents and
 * a balanced ledger posting, or, when the engine holds the bill, onto a visible exception.
 */

const Period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "A period is YYYY-MM");

/** One reading of the account's history (Metering's, from Phase 5). */
export const readingFactSchema = z.object({
  period: Period,
  kind: z.enum(["actual", "estimate"]),
  dial: z.number().int().min(0).optional(),
  /** Units for the span ending at this reading. */
  units: z.number().int().min(0).optional(),
  /** Months in that span. */
  months: z.number().int().min(1).max(36).optional(),
  flags: z.array(z.enum(["baseline_gap", "corrected", "disputed"])).default([]),
});

export const usageInputSchema = z.object({
  /** Replaying a call with the same key returns the document it issued. */
  idempotencyKey: z.string().trim().min(8).max(120),
  accountId: z.uuid(),
  customerId: z.uuid().optional(),
  categoryId: z.uuid(),
  invoiceTypeId: z.uuid(),
  servicePointId: z.uuid().optional(),
  schemeId: z.uuid().optional(),
  zoneId: z.uuid().optional(),
  period: Period,
  /** A dial reading, or none for an estimate (optionally with explicit units). */
  reading: z.object({ dial: z.number().int().min(0).optional(), units: z.number().int().min(0).optional(), rollover: z.boolean().optional() }),
  /** The account's earlier readings; the latest trusted actual before `period` is the baseline. */
  readings: z.array(readingFactSchema).max(60).default([]),
  /** False when the account's status says usage is not billed (Accounts' `chargesApplying`): the bill is held. */
  billable: z.boolean().default(true),
  dueOn: z.iso.date().optional(),
});
export type UsageInput = z.infer<typeof usageInputSchema>;

export type Prepared =
  | { kind: "draft"; draft: Draft }
  | { kind: "held"; code: string; message: string; period: string }
  | { kind: "none"; outcome: "baseline" | "duplicate" | "none" };

export async function organizationCurrency(tx: Transaction): Promise<string> {
  const [row] = await tx.select({ currency: organizationSettings.currency }).from(organizationSettings);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Organization settings not found" });
  return row.currency;
}

export async function todayOf(tx: Transaction): Promise<string> {
  return todayIn((await readSetting(tx, regionalSetting)).value.timeZone);
}

export const dimensionsOf = (i: { servicePointId?: string | undefined; schemeId?: string | undefined; zoneId?: string | undefined; categoryId?: string | undefined }): Dimensions => ({
  servicePointId: i.servicePointId ?? null,
  schemeId: i.schemeId ?? null,
  zoneId: i.zoneId ?? null,
  categoryId: i.categoryId ?? null,
});

/** What the category was priced with in each month of the span, read through Tariffs' published interface (T-04). */
async function pricing(env: ActionEnv, categoryId: string, months: readonly string[]): Promise<PricedMonth[]> {
  const out: PricedMonth[] = [];
  for (const period of months) {
    const on = monthStart(period);
    const assignment = await categoryPricing(env.tx, env.organizationId, categoryId, on);
    if (!assignment?.tariffId) continue;
    const version = await tariffVersionInForce(env.tx, env.organizationId, assignment.tariffId, on);
    if (!version) continue;
    if (version.content.type === "flat_rate") throw new TRPCError({ code: "BAD_REQUEST", message: "Flat-rate tariffs are not priced by usage" });
    const standing = assignment.standingChargeItemId ? await chargeItemAmountInForce(env.tx, env.organizationId, assignment.standingChargeItemId, on) : null;
    const rent = assignment.meterRentItemId ? await chargeItemAmountInForce(env.tx, env.organizationId, assignment.meterRentItemId, on) : null;
    out.push({
      period,
      tariffVersionId: version.id,
      bands: bandsFor(version.content).map((b) => ({ to: b.to, rate: b.rate })),
      standing: (standing?.amount ?? 0n) + (rent?.amount ?? 0n),
      standingChargeItemId: standing ? assignment.standingChargeItemId : null,
      standingAmountId: standing?.id ?? null,
      meterRentAmountId: rent?.id ?? null,
    });
  }
  return out;
}

/** The account's engine-made documents from `from` on, with whether each was reversed. */
async function storedDocuments(tx: Transaction, accountId: string, from: string): Promise<StoredDocument[]> {
  const docs = await tx
    .select()
    .from(document)
    .where(and(eq(document.accountId, accountId), inArray(document.kind, ["invoice", "credit_note", "debit_note"]), gte(document.periodTo, from)));
  if (docs.length === 0) return [];
  const reversals = await tx
    .select({ of: document.reversesDocumentId })
    .from(document)
    .where(and(eq(document.accountId, accountId), eq(document.kind, "reversal")));
  const reversed = new Set(reversals.map((r) => r.of));
  const lines = await tx.select().from(documentLine).where(inArray(documentLine.documentId, docs.map((d) => d.id)));
  return docs.map((d) => ({
    id: d.id,
    kind: d.kind,
    periodTo: d.periodTo,
    total: d.total,
    reversed: reversed.has(d.id),
    lines: lines.filter((l) => l.documentId === d.id).sort((a, b) => a.position - b.position),
  }));
}

/**
 * Prices the bill without writing anything. `excluded` lists documents to treat as voided (a
 * re-bill prices as if the document it replaces were already reversed).
 */
export async function prepareUsage(env: ActionEnv, input: UsageInput, excluded: ReadonlySet<string> = new Set()): Promise<Prepared> {
  const { tx } = env;
  const policy = (await readSetting(tx, billingPolicySetting)).value;
  const p = periodIndex(input.period);
  const readings: Reading[] = input.readings.map((r, i) => ({
    id: i + 1,
    period: r.period,
    kind: r.kind,
    ...(r.dial !== undefined ? { dial: r.dial } : {}),
    ...(r.units !== undefined ? { units: r.units } : {}),
    ...(r.months !== undefined ? { months: r.months } : {}),
    voided: false,
    flags: r.flags,
  }));
  const before = readings.filter((r) => r.kind === "actual" && periodIndex(r.period) < p).map((r) => periodIndex(r.period));
  const lp = before.length ? Math.max(...before) : null;
  const first = lp === null ? p : lp + 1;
  if (p - first > 36) throw new TRPCError({ code: "BAD_REQUEST", message: "The reading span is longer than 36 months" });
  const months = Array.from({ length: p - first + 1 }, (_, i) => periodFromIndex(first + i));
  const tariffs = engineTariffs(await pricing(env, input.categoryId, months));
  const stored = await storedDocuments(tx, input.accountId, monthStart(periodFromIndex(first)));
  const docs = engineDocsFrom(stored, excluded);

  const account = {
    ...newAccount({
      status: input.billable ? "ACTIVE" : "BLOCKED",
      digits: policy.meterDigits,
      policy: { scaling: policy.tierScaling, avgN: policy.estimateAverageOf, fallback: policy.estimateFallbackUnits, ceiling: policy.outlierCeilingUnitsPerMonth },
    }),
    readings,
    docs,
    seq: readings.length + docs.length,
  };
  const { outcome } = billReading(account, tariffs, input.period, {
    ...(input.reading.dial !== undefined ? { dial: input.reading.dial } : {}),
    ...(input.reading.units !== undefined ? { units: input.reading.units } : {}),
    ...(input.reading.rollover !== undefined ? { rollover: input.reading.rollover } : {}),
  });
  if (outcome.kind === "held") return { kind: "held", code: outcome.exception.code, message: outcome.exception.message, period: input.period };
  if (outcome.kind !== "billed") return { kind: "none", outcome: outcome.kind === "baseline" ? "baseline" : outcome.kind === "duplicate" ? "duplicate" : "none" };

  const doc = outcome.doc;
  const credit = doc.type === "credit_note";
  return {
    kind: "draft",
    draft: {
      kind: credit ? "credit_note" : "invoice",
      entryType: credit ? "credit" : "charge",
      invoiceTypeId: input.invoiceTypeId,
      accountId: input.accountId,
      customerId: input.customerId ?? null,
      currency: await organizationCurrency(tx),
      lines: linesFromEngineDoc(doc),
      issuedOn: await todayOf(tx),
      dueOn: input.dueOn ?? null,
      idempotencyKey: input.idempotencyKey,
      dimensions: dimensionsOf(input),
    },
  };
}

/** A held bill becomes an exception with an owner and an age (NF-24), once per account, period and cause. */
export async function holdBill(env: ActionEnv, accountId: string, held: Extract<Prepared, { kind: "held" }>) {
  const raised = await raiseException(env.tx, env.organizationId, {
    type: held.code === "NO_BASELINE" ? "NO_BASELINE" : "UNBILLED_ACCOUNT",
    source: "billing",
    title: `Bill held for ${held.period}: ${held.code}`,
    detail: held.message,
    subject: { kind: "account", ref: accountId },
    ownerUserId: env.actor.userId,
    dedupeKey: `billing.held:${accountId}:${held.period}:${held.code}`,
  });
  await env.audit({ action: "billing.bill_held", subjectType: "account", subjectId: accountId, after: { period: held.period, code: held.code, message: held.message, exceptionId: raised.id } });
  await env.publish(billHeld, { accountId, period: held.period, code: held.code, message: held.message, exceptionId: raised.id });
  return raised.id;
}

export async function presentPosted(tx: Transaction, doc: Awaited<ReturnType<typeof documentByKey>> & object) {
  return { ...toDocumentDto(doc), lines: (await linesOf(tx, doc.id)).map(toLineDto) };
}

/** Posts the invoice event, audit entry and returns the result; shared by issue and re-bill. */
export async function announceIssued(env: ActionEnv, posted: Awaited<ReturnType<typeof postDraft>>, extra: { replacesDocumentId?: string | null } = {}) {
  const d = posted.document;
  if (d.kind === "reversal") throw new Error("announceIssued is for issued documents");
  await env.audit({
    action: `billing.${d.kind}_issued`,
    subjectType: "document",
    subjectId: d.id,
    after: plain({ number: d.number, accountId: d.accountId, total: d.total, lines: d.lineCount, periodFrom: d.periodFrom, periodTo: d.periodTo, replaces: extra.replacesDocumentId ?? null }),
  });
  await env.publish(documentIssued, {
    ...documentFacts(d, env.actor.userId),
    kind: d.kind,
    relatedDocumentId: d.relatedDocumentId,
    replacesDocumentId: d.replacesDocumentId,
  });
}

export type IssueResult =
  | { outcome: "issued"; replayed: boolean; document: Awaited<ReturnType<typeof presentPosted>> }
  | { outcome: "held"; code: string; message: string; exceptionId: string }
  | { outcome: "baseline" | "duplicate" | "none" };

/** B-10: issues the bill for an account and period, or holds it. Idempotent on the key. */
export async function issueUsage(env: UserActionEnv, input: UsageInput): Promise<IssueResult> {
  await lockAccount(env.tx, input.accountId);
  const earlier = await documentByKey(env.tx, input.idempotencyKey);
  if (earlier) {
    if (earlier.accountId !== input.accountId || !["invoice", "credit_note"].includes(earlier.kind) || earlier.periodTo?.slice(0, 7) !== input.period) {
      throw new TRPCError({ code: "CONFLICT", message: "That idempotency key was used for a different request" });
    }
    return { outcome: "issued", replayed: true, document: await presentPosted(env.tx, earlier) };
  }
  const prepared = await prepareUsage(env, input);
  if (prepared.kind === "held") {
    return { outcome: "held", code: prepared.code, message: prepared.message, exceptionId: await holdBill(env, input.accountId, prepared) };
  }
  if (prepared.kind === "none") return { outcome: prepared.outcome };
  const posted = await postDraft(env, prepared.draft);
  await announceIssued(env, posted);
  return { outcome: "issued", replayed: false, document: await presentPosted(env.tx, posted.document) };
}
