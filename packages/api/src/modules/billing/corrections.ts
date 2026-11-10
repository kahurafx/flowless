import { billedConsumption, correctPeriod, newAccount, periodFromIndex, periodIndex, sum, type Reading } from "@flowless/billing-engine";
import type { Transaction } from "@flowless/db";
import { document } from "@flowless/db/schema/billing";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { ActionEnv, UserActionEnv } from "../../kernel/action-env";
import { approvalOutcome } from "../../kernel/approval-store";
import { readSetting } from "../../kernel/config-store";
import { loadEntitlements } from "../../kernel/entitlement-store";
import { resolveByDedupeKey } from "../../kernel/exception-store";
import { regionalSetting } from "../../kernel/regional";
import { chargesApplyingTo, servicePointsOf } from "../accounts";
import { readingsFor } from "../metering";
import { invoiceTypeIdByCode } from "../tariffs";
import { CORRECTION_APPROVAL_KIND } from "./approvals";
import { correctionPath, correctionSettings, formatMinor, graceEnd, renderTemplate, type PathDecision } from "./correction-policy";
import { engineDocsFrom, engineTariffs, linesFromEngineDoc, monthEnd, monthStart, type DraftLine } from "./mapping";
import { announceNote } from "./notes-announce";
import { documentByKey, lockAccount, postDraft, type DocumentRow } from "./post";
import { analyseReadings, type RunReading } from "./run-input";
import { billingPolicySetting } from "./settings";
import { dimensionsOf, organizationCurrency, presentPosted, pricing, storedDocuments, todayOf } from "./usage";

/*
 * Corrections (B-13, B-14): a late reading, a corrected reading or a voided reading for a
 * period that is closed or already billed posts in the CURRENT open period as a credit or
 * debit note that cites the original invoice and carries service_from / service_to on its
 * lines. The amount is the engine's `correctPeriod` (what the corrected reading prices to
 * against what the span was billed). One document per affected period, because a corrected
 * reading also moves the span of the readings after it. Nothing posted is updated.
 *
 * Who may post: within the grace window (default: the invoice's due date) a user with
 * `billing:run` posts it directly; after it, an approved K-05 request (`billing.correction`,
 * `billing:approve`). A large deviation also needs evidence (a file id or a note). The rule is
 * the pure `correctionPath`.
 */

export const evidenceSchema = z.object({ fileId: z.uuid().optional(), note: z.string().trim().max(2000).optional() });
export type Evidence = z.infer<typeof evidenceSchema>;
const hasEvidence = (e: Evidence | undefined) => !!e && (!!e.fileId || (e.note?.length ?? 0) >= 5);

export const correctionKey = (id: string, period: string) => `correction:${id}:${period}`;
export const exceptionKey = (accountId: string, period: string) => `correction:${accountId}:${period}`;
export const correctionSubject = (accountId: string, period: string) => `correction:${accountId}:${period}`;

export interface ProposedDocument {
  /** The period whose reading this document re-prices. */
  period: string;
  kind: "credit_note" | "debit_note";
  total: bigint;
  /** The original invoice of that period, if it was billed. */
  original: { id: string; number: string; issuedOn: string; dueOn: string | null; total: bigint; invoiceTypeId: string } | null;
  lines: DraftLine[];
  /** The B-13 text. */
  text: string;
}

export interface Proposal {
  accountId: string;
  /** The first period asked about. */
  period: string;
  currency: string;
  customerId: string | null;
  categoryId: string;
  servicePointId: string;
  documents: ProposedDocument[];
  /** Periods the engine could not re-price (and why): never silent. */
  problems: { period: string; code: string; message: string }[];
}

type Reader = ActionEnv;

/** The live invoice of a period (not reversed), if any. */
async function originalInvoice(tx: Transaction, accountId: string, period: string) {
  const [row] = await tx
    .select()
    .from(document)
    .where(
      and(
        eq(document.accountId, accountId),
        eq(document.kind, "invoice"),
        eq(document.periodTo, monthEnd(period)),
        sql`not exists (select 1 from billing.document r where r.reverses_document_id = ${document.id})`,
      ),
    )
    .orderBy(document.createdAt)
    .limit(1);
  return row;
}

/** Prices the correction of `period` and every later billed period, without writing anything. */
export async function proposeCorrection(env: Reader, input: { accountId: string; period: string }): Promise<Proposal | null> {
  const { tx } = env;
  const facts = await chargesApplyingTo(tx, input.accountId);
  if (!facts) throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
  if (!facts.categoryId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The account has no tariff category" });
  if (!(await loadEntitlements(tx)).includes("metering")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Corrections are priced from Metering's readings; without Metering use a credit or debit note" });
  }
  const points = await servicePointsOf(tx, input.accountId);
  if (points.length === 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The account has no service point" });
  const tz = (await readSetting(tx, regionalSetting)).value.timeZone;
  const policy = (await readSetting(tx, billingPolicySetting)).value;

  // Pick the service point that has readings.
  let views: Awaited<ReturnType<typeof readingsFor>> = [];
  let servicePointId = points[0]!.servicePointId;
  for (const p of points) {
    const found = await readingsFor(tx, { servicePointId: p.servicePointId, validOnly: true, actualOnly: true, limit: 300 });
    if (found.length > views.length) {
      views = found;
      servicePointId = p.servicePointId;
    }
  }
  const runReadings: RunReading[] = views.map((v) => ({ id: v.id, meterId: v.meterId, value: v.value, readAt: v.readAt, recordedAt: v.recordedAt, purpose: v.purpose, kind: v.kind, status: v.status, cleared: v.cleared, rolloverConfirmed: v.rolloverConfirmed, replacesReadingId: v.replacesReadingId, dialDigits: v.dialDigits }));
  // Every cleared routine reading as history (a period far ahead takes them all).
  const { history } = analyseReadings(runReadings, "9999-12", tz);
  const readings: Reading[] = history.map((h, i) => {
    const prev = history[i - 1];
    const carry = prev && h.units !== undefined ? h.units - (h.dial - prev.dial) : 0;
    return { id: i + 1, period: h.period, kind: "actual", dial: h.dial, ...(h.units !== undefined ? { units: h.units, months: h.months ?? 1 } : {}), ...(carry ? { carry } : {}), voided: false, flags: h.flags };
  });
  const affected = readings.filter((r) => r.units !== undefined && periodIndex(r.period) >= periodIndex(input.period));
  if (affected.length === 0) return null;

  const firstIdx = Math.min(...affected.map((r) => periodIndex(r.period) - (r.months ?? 1))) + 1;
  const lastIdx = Math.max(...affected.map((r) => periodIndex(r.period)));
  const months = Array.from({ length: lastIdx - firstIdx + 1 }, (_, i) => periodFromIndex(firstIdx + i));
  const tariffs = engineTariffs(await pricing(env, facts.categoryId, months, false));
  const docs = engineDocsFrom(await storedDocuments(tx, input.accountId, monthStart(periodFromIndex(firstIdx))));
  let account = {
    ...newAccount({ digits: policy.meterDigits, policy: { scaling: policy.tierScaling, avgN: policy.estimateAverageOf, fallback: policy.estimateFallbackUnits, ceiling: policy.outlierCeilingUnitsPerMonth } }),
    readings,
    docs,
    seq: readings.length + docs.length,
  };

  const settings = (await readSetting(tx, correctionSettings)).value;
  const currency = await organizationCurrency(tx);
  const out: ProposedDocument[] = [];
  const problems: Proposal["problems"] = [];
  for (const r of affected.sort((a, b) => periodIndex(a.period) - periodIndex(b.period))) {
    const lp = periodIndex(r.period) - (r.months ?? 1);
    const billedBefore = sum(billedConsumption(account, lp, periodIndex(r.period)), (l) => l.amount);
    const result = correctPeriod(account, tariffs, r.period);
    account = result.account as typeof account;
    if (result.outcome.kind === "held") {
      problems.push({ period: r.period, code: result.outcome.exception.code, message: result.outcome.exception.message });
      continue;
    }
    if (result.outcome.kind !== "billed") continue;
    const doc = result.outcome.doc;
    const original = await originalInvoice(tx, input.accountId, r.period);
    const total = doc.total;
    const kind = total < 0n ? "credit_note" : "debit_note";
    const base = linesFromEngineDoc(doc);
    const from = base[0]?.serviceFrom ?? monthStart(r.period);
    const to = base[0]?.serviceTo ?? monthEnd(r.period);
    const text = renderTemplate(kind === "credit_note" ? settings.creditTemplate : settings.debitTemplate, {
      original_number: original?.number ?? "(no earlier bill)",
      period: r.period,
      amount: formatMinor(total, currency),
      direction: kind === "credit_note" ? "a credit" : "an extra charge",
      from,
      to,
      units: String(doc.lines[0]?.units ?? 0),
    });
    const prevReading = readings.find((x) => periodIndex(x.period) === lp);
    const lines: DraftLine[] = base.map((l) => ({
      ...l,
      description: text,
      calculation: {
        ...(l.calculation ?? {}),
        working: { period: r.period, dial: r.dial ?? null, previousPeriod: prevReading?.period ?? null, previousDial: prevReading?.dial ?? null, units: r.units ?? null, billedBefore: billedBefore.toString(), repriced: (billedBefore + total).toString(), difference: total.toString() },
        originalDocumentId: original?.id ?? null,
        originalNumber: original?.number ?? null,
      },
    }));
    out.push({
      period: r.period,
      kind,
      total,
      original: original ? { id: original.id, number: original.number, issuedOn: original.issuedOn, dueOn: original.dueOn, total: original.total, invoiceTypeId: original.invoiceTypeId } : null,
      lines,
      text,
    });
  }
  if (out.length === 0 && problems.length === 0) return null;
  return { accountId: input.accountId, period: input.period, currency, customerId: facts.customerId, categoryId: facts.categoryId, servicePointId, documents: out, problems };
}

/** The route a proposal takes today, over all its documents. */
export async function decideRoute(tx: Transaction, proposal: Proposal, evidence: Evidence | undefined): Promise<PathDecision & { amount: bigint }> {
  const settings = (await readSetting(tx, correctionSettings)).value;
  const today = await todayOf(tx);
  const amount = proposal.documents.reduce((s, d) => s + (d.total < 0n ? -d.total : d.total), 0n);
  const originals = proposal.documents.map((d) => d.original);
  const first = originals.find((o) => o) ?? null;
  // The earliest grace end decides: one document past its window sends the whole request to approval.
  const ends = originals.map((o) => graceEnd(o, settings.graceWindow));
  const earliest = ends.some((e) => e === null) ? null : ends.map((e) => e as string).sort()[0] ?? null;
  const originalTotal = originals.every((o) => o) ? originals.reduce((s, o) => s + (o!.total < 0n ? -o!.total : o!.total), 0n) : first ? first.total : null;
  const decision = correctionPath({ today, graceEnd: earliest, total: amount, originalTotal, largeDeviation: settings.largeDeviation, evidence: hasEvidence(evidence) });
  return { ...decision, amount };
}

export const postCorrectionInput = z.object({
  /** Client-minted: a retry returns the documents already posted. Optional when an approval is given (its id is used). */
  id: z.uuid().optional(),
  accountId: z.uuid(),
  /** The period of the late or corrected reading. */
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  evidence: evidenceSchema.optional(),
  /** The approved `billing.correction` request, required after the grace window. */
  approvalId: z.uuid().optional(),
  note: z.string().trim().max(2000).optional(),
});
export type PostCorrectionInput = z.infer<typeof postCorrectionInput>;

export type PostCorrectionResult =
  | { outcome: "posted"; replayed: boolean; documents: Awaited<ReturnType<typeof presentPosted>>[] }
  | { outcome: "nothing"; reason: string; problems: Proposal["problems"] };

const refuse = (message: string, code: "PRECONDITION_FAILED" | "BAD_REQUEST" | "NOT_FOUND" = "PRECONDITION_FAILED") => new TRPCError({ code, message });

/** Posts the correction documents (B-14). */
export async function postCorrection(env: UserActionEnv, input: PostCorrectionInput): Promise<PostCorrectionResult> {
  const { tx } = env;
  await lockAccount(tx, input.accountId);
  const idPart = input.approvalId ?? input.id;
  if (!idPart) throw refuse("Give an id, or the approval", "BAD_REQUEST");
  // Replay: the first document's key is enough.
  const firstKey = correctionKey(idPart, input.period);
  const earlierFirst = await documentByKey(tx, firstKey);
  if (earlierFirst) {
    if (earlierFirst.accountId !== input.accountId) throw new TRPCError({ code: "CONFLICT", message: "That id was used for another account" });
    const rows = await tx.select().from(document).where(and(eq(document.accountId, input.accountId), sql`${document.idempotencyKey} like ${`correction:${idPart}:%`}`)).orderBy(document.createdAt);
    return { outcome: "posted", replayed: true, documents: await Promise.all(rows.map((d) => presentPosted(tx, d))) };
  }

  const proposal = await proposeCorrection(env, input);
  if (!proposal || proposal.documents.length === 0) {
    await resolveByDedupeKey(tx, exceptionKey(input.accountId, input.period), "Nothing to correct");
    return { outcome: "nothing", reason: proposal?.problems.map((p) => `${p.period}: ${p.message}`).join("; ") || "The corrected reading prices to what was billed", problems: proposal?.problems ?? [] };
  }
  const route = await decideRoute(tx, proposal, input.evidence);
  if (route.needsEvidence) throw refuse("This is a large correction: attach evidence (a file or a note of at least 5 characters)");
  let reasonCode: string | null = null;
  if (route.route === "approval") {
    if (!input.approvalId) throw refuse(`${route.reasons[0]}: an approved request is needed (corrections.request)`);
    const approval = await approvalOutcome(tx, input.approvalId);
    if (!approval || approval.kind !== CORRECTION_APPROVAL_KIND) throw refuse("There is no such approval for a correction", "NOT_FOUND");
    if (approval.subjectRef !== correctionSubject(input.accountId, input.period)) throw refuse("This approval is for another account or period");
    if (approval.status !== "approved") throw refuse(`The approval is ${approval.status}; a correction needs an approved request`);
    if (approval.amount !== route.amount) throw refuse("The correction now prices to a different amount than was approved; ask again");
    reasonCode = approval.reasonCode;
  }

  const issuedOn = await todayOf(tx);
  const documents: Awaited<ReturnType<typeof presentPosted>>[] = [];
  for (const d of proposal.documents) {
    const evidenceNote = input.evidence?.note ? ` Evidence: ${input.evidence.note}` : "";
    const lines: DraftLine[] = d.lines.map((l) => ({ ...l, calculation: { ...(l.calculation ?? {}), evidence: input.evidence ?? null, route: route.route, approvalId: input.approvalId ?? null } }));
    const posted = await postDraft(env, {
      kind: d.kind,
      entryType: d.kind === "credit_note" ? "credit" : "adjustment",
      invoiceTypeId: d.original?.invoiceTypeId ?? (await fallbackInvoiceType(tx, env.organizationId)),
      accountId: input.accountId,
      customerId: proposal.customerId,
      currency: proposal.currency,
      lines,
      issuedOn,
      relatedDocumentId: d.original?.id ?? null,
      note: `${d.text}${input.note ? ` ${input.note}` : ""}${evidenceNote}`.slice(0, 2000),
      idempotencyKey: correctionKey(idPart, d.period),
      dimensions: dimensionsOf({ categoryId: proposal.categoryId, servicePointId: proposal.servicePointId }),
    });
    await announceNote(env, posted, input.approvalId ?? "grace-window", reasonCode ?? "LATE_READING");
    await env.audit({
      action: "billing.correction_posted",
      subjectType: "document",
      subjectId: posted.document.id,
      after: { period: d.period, route: route.route, total: d.total.toString(), related: d.original?.id ?? null, approvalId: input.approvalId ?? null, evidence: input.evidence ?? null },
      reason: input.note ?? "Reading correction",
    });
    documents.push(await presentPosted(tx, posted.document as DocumentRow));
  }
  for (const d of proposal.documents) await resolveByDedupeKey(tx, exceptionKey(input.accountId, d.period), "Correction posted");
  await resolveByDedupeKey(tx, exceptionKey(input.accountId, input.period), "Correction posted");
  return { outcome: "posted", replayed: false, documents };
}

async function fallbackInvoiceType(tx: Transaction, organizationId: string): Promise<string> {

  const code = (await readSetting(tx, billingPolicySetting)).value.usageInvoiceTypeCode;
  const id = await invoiceTypeIdByCode(tx, organizationId, code);
  if (!id) throw refuse(`No invoice type "${code}" for a correction with no earlier bill`);
  return id;
}

