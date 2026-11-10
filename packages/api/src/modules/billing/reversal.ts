import { document } from "@flowless/db/schema/billing";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { UserActionEnv } from "../../kernel/action-env";
import { plain } from "../../kernel/text";
import { documentReversed } from "./events";
import { documentByKey, documentById, linesOf, lockAccount, postDraft, transactionOf, type DocumentRow } from "./post";
import { documentFacts, toDocumentDto, toLineDto } from "./present";
import { announceIssued, dimensionsOf, holdBill, prepareUsage, presentPosted, todayOf, usageInputSchema, type IssueResult } from "./usage";
import type { DraftLine } from "./mapping";

/*
 * Void and re-bill (B-11, I-3, NF-22). A void never changes the document: it posts a reversal
 * document (the lines negated) and a reversal ledger transaction that mirrors the original
 * entries, so the balance returns to what it was. A re-bill is a void plus a new invoice that
 * names the voided one (`replaces_document_id`), in one transaction.
 */

export const voidInputSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  documentId: z.uuid(),
  reason: z.string().trim().min(1, "Say why").max(2000),
});
export type VoidInput = z.infer<typeof voidInputSchema>;

export const rebillInputSchema = z.object({
  documentId: z.uuid(),
  reason: z.string().trim().min(1, "Say why").max(2000),
  /** The corrected bill, for the same account and the period of the document it replaces. */
  bill: usageInputSchema.omit({ idempotencyKey: true }),
  idempotencyKey: z.string().trim().min(8).max(120),
});
export type RebillInput = z.infer<typeof rebillInputSchema>;

const refuse = (message: string, code: "PRECONDITION_FAILED" | "CONFLICT" = "PRECONDITION_FAILED") => new TRPCError({ code, message });

/** Refuses a document that cannot be voided: a reversal, one already reversed, or one with live notes against it. */
async function assertVoidable(env: UserActionEnv, original: DocumentRow) {
  if (original.kind === "reversal") throw refuse("A reversal cannot be voided");
  const [again] = await env.tx.select({ id: document.id }).from(document).where(and(eq(document.reversesDocumentId, original.id)));
  if (again) throw refuse("This document is already voided", "CONFLICT");
  const notes = await env.tx.select({ id: document.id }).from(document).where(and(eq(document.relatedDocumentId, original.id)));
  if (notes.length) {
    const reversed = await env.tx.select({ of: document.reversesDocumentId }).from(document).where(and(eq(document.accountId, original.accountId), inArray(document.reversesDocumentId, notes.map((n) => n.id))));
    if (reversed.length < notes.length) throw refuse("Void the credit and debit notes issued against this document first");
  }
}

/** Posts the reversal of `original` (the caller holds the account lock and has checked it can be voided). */
async function postReversal(env: UserActionEnv, original: DocumentRow, reason: string, key: string) {
  const lines = await linesOf(env.tx, original.id);
  const draftLines: DraftLine[] = lines.map((l) => ({
    lineType: l.lineType,
    description: l.description,
    quantity: l.quantity,
    unitRate: l.unitRate,
    amount: -l.amount,
    serviceFrom: l.serviceFrom,
    serviceTo: l.serviceTo,
    tariffVersionId: l.tariffVersionId,
    chargeItemId: l.chargeItemId,
    chargeItemAmountId: l.chargeItemAmountId,
    chargeType: l.chargeType,
    calculation: { ...((l.calculation as Record<string, unknown> | null) ?? {}), reversalOf: original.id },
  }));
  const posted = await postDraft(env, {
    kind: "reversal",
    entryType: "reversal",
    invoiceTypeId: original.invoiceTypeId,
    accountId: original.accountId,
    customerId: original.customerId,
    currency: original.currency,
    lines: draftLines,
    issuedOn: await todayOf(env.tx),
    reversesDocumentId: original.id,
    note: reason,
    idempotencyKey: key,
    mirrorOf: await transactionOf(env.tx, original.id),
  });
  await env.audit({ action: "billing.document_voided", subjectType: "document", subjectId: original.id, after: plain({ reversal: posted.document.id, number: posted.document.number, total: posted.document.total }), reason });
  await env.publish(documentReversed, { ...documentFacts(posted.document, env.actor.userId), kind: "reversal", reversesDocumentId: original.id, reason });
  return posted;
}

export async function voidDocument(env: UserActionEnv, input: VoidInput) {
  const original = await documentById(env.tx, input.documentId);
  await lockAccount(env.tx, original.accountId);
  const earlier = await documentByKey(env.tx, input.idempotencyKey);
  if (earlier) {
    if (earlier.reversesDocumentId !== original.id) throw refuse("That idempotency key was used for a different request", "CONFLICT");
    return { replayed: true, reversal: { ...toDocumentDto(earlier), lines: (await linesOf(env.tx, earlier.id)).map(toLineDto) } };
  }
  await assertVoidable(env, original);
  const posted = await postReversal(env, original, input.reason, input.idempotencyKey);
  return { replayed: false, reversal: { ...toDocumentDto(posted.document), lines: posted.lines.map(toLineDto) } };
}

export type RebillResult = { replayed: boolean; reversal: Awaited<ReturnType<typeof voidDocument>>["reversal"]; replacement: Awaited<ReturnType<typeof presentPosted>> } | Exclude<IssueResult, { outcome: "issued" }>;

export async function rebill(env: UserActionEnv, input: RebillInput): Promise<RebillResult> {
  const original = await documentById(env.tx, input.documentId);
  await lockAccount(env.tx, original.accountId);
  const voidKey = `${input.idempotencyKey}:void`;
  const billKey = `${input.idempotencyKey}:rebill`;
  const earlier = await documentByKey(env.tx, voidKey);
  if (earlier) {
    const replacement = await documentByKey(env.tx, billKey);
    if (earlier.reversesDocumentId !== original.id || !replacement) throw refuse("That idempotency key was used for a different request", "CONFLICT");
    return {
      replayed: true,
      reversal: { ...toDocumentDto(earlier), lines: (await linesOf(env.tx, earlier.id)).map(toLineDto) },
      replacement: await presentPosted(env.tx, replacement),
    };
  }
  if (original.kind !== "invoice") throw refuse("Only an invoice can be re-billed");
  if (input.bill.accountId !== original.accountId) throw refuse("The re-bill must be for the same account");
  if (!original.periodTo || original.periodTo.slice(0, 7) !== input.bill.period) throw refuse("The re-bill must be for the period of the invoice it replaces");
  await assertVoidable(env, original);

  // Price the replacement as if the original were already void; if the engine holds it, nothing is voided.
  const prepared = await prepareUsage(env, { ...input.bill, idempotencyKey: billKey }, new Set([original.id]));
  if (prepared.kind === "held") {
    return { outcome: "held", code: prepared.code, message: prepared.message, exceptionId: await holdBill(env, original.accountId, prepared) };
  }
  if (prepared.kind === "none") return { outcome: prepared.outcome };
  if (prepared.draft.kind !== "invoice") throw refuse("The corrected bill is a credit, not an invoice: void the document and issue a credit note instead");
  const reversal = await postReversal(env, original, input.reason, voidKey);
  const replacement = await postDraft(env, { ...prepared.draft, replacesDocumentId: original.id, note: input.reason, dimensions: dimensionsOf(input.bill) });
  await announceIssued(env, replacement, { replacesDocumentId: original.id });
  return {
    replayed: false,
    reversal: { ...toDocumentDto(reversal.document), lines: reversal.lines.map(toLineDto) },
    replacement: await presentPosted(env.tx, replacement.document),
  };
}
