import { document } from "@flowless/db/schema/billing";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type { UserActionEnv } from "../../kernel/action-env";
import { approvalOutcome } from "../../kernel/approval-store";
import { ADJUSTMENT_APPROVAL_KIND } from "./approvals";
import { sumLines, type DraftLine } from "./mapping";
import { documentById, documentByKey, lockAccount, postDraft } from "./post";
import { announceNote } from "./notes-announce";
import { dimensionsOf, organizationCurrency, presentPosted, todayOf } from "./usage";

/*
 * Credit and debit notes (B-11, B-14). A note is its own document that cites the document it
 * corrects (optional for a stand-alone credit), posts a balanced ledger transaction and never
 * changes anything already posted. It needs an approved K-05 request (`adjustments.request`)
 * for the same account and amount, used once: the idempotency key is derived from the approval.
 */

export const NOTE_KINDS = ["credit_note", "debit_note"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

const Money = z.bigint().positive().max(10n ** 15n);

export const noteLineSchema = z.object({
  description: z.string().trim().min(1).max(300),
  /** The line's size, always positive: the note's kind says which way it moves the balance. */
  amount: Money,
  serviceFrom: z.iso.date().optional(),
  serviceTo: z.iso.date().optional(),
});

export const noteInputSchema = z.object({
  approvalId: z.uuid(),
  accountId: z.uuid(),
  customerId: z.uuid().optional(),
  invoiceTypeId: z.uuid(),
  relatedDocumentId: z.uuid().optional(),
  lines: z.array(noteLineSchema).min(1).max(50),
  note: z.string().trim().min(1, "Say why").max(2000),
  servicePointId: z.uuid().optional(),
  schemeId: z.uuid().optional(),
  zoneId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  dueOn: z.iso.date().optional(),
});
export type NoteInput = z.infer<typeof noteInputSchema>;

/** The approval subject for a request: ties it to a kind and account. */
export const adjustmentSubject = (kind: NoteKind, accountId: string, id: string) => `${kind}:${accountId}:${id}`;

const refuse = (message: string, code: "PRECONDITION_FAILED" | "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND" = "PRECONDITION_FAILED") => new TRPCError({ code, message });

/** A credit may not take a related document below zero: its total plus live notes against it stays at or above nothing. */
async function assertRelated(env: UserActionEnv, kind: NoteKind, input: NoteInput, total: bigint) {
  if (!input.relatedDocumentId) return;
  const related = await documentById(env.tx, input.relatedDocumentId);
  if (related.accountId !== input.accountId) throw refuse("The related document belongs to another account");
  if (!["invoice", "debit_note"].includes(related.kind)) throw refuse("A note can only correct an invoice or a debit note");
  const notes = await env.tx.select().from(document).where(and(eq(document.relatedDocumentId, related.id), ne(document.kind, "reversal")));
  const reversed = notes.length
    ? new Set((await env.tx.select({ of: document.reversesDocumentId }).from(document).where(inArray(document.reversesDocumentId, notes.map((n) => n.id)))).map((r) => r.of))
    : new Set<string | null>();
  const [voided] = await env.tx.select({ id: document.id }).from(document).where(eq(document.reversesDocumentId, related.id));
  if (voided) throw refuse("The related document is voided");
  const net = related.total + notes.filter((n) => !reversed.has(n.id)).reduce((s, n) => s + n.total, 0n);
  if (kind === "credit_note" && net + total < 0n) throw refuse("The credit is more than is left on the related document");
}

export async function issueNote(env: UserActionEnv, kind: NoteKind, input: NoteInput) {
  const key = `note:${input.approvalId}`;
  await lockAccount(env.tx, input.accountId);
  const earlier = await documentByKey(env.tx, key);
  if (earlier) {
    if (earlier.accountId !== input.accountId || earlier.kind !== kind) throw refuse("That approval was used for a different note", "CONFLICT");
    return { replayed: true, document: await presentPosted(env.tx, earlier) };
  }
  const sign = kind === "credit_note" ? -1n : 1n;
  const lines: DraftLine[] = input.lines.map((l) => ({
    lineType: "adjustment",
    description: l.description,
    amount: sign * l.amount,
    serviceFrom: l.serviceFrom && l.serviceTo ? l.serviceFrom : null,
    serviceTo: l.serviceFrom && l.serviceTo ? l.serviceTo : null,
    chargeType: "adjustment",
    calculation: { code: null },
  }));
  const total = sumLines(lines);

  const approval = await approvalOutcome(env.tx, input.approvalId);
  if (!approval || approval.kind !== ADJUSTMENT_APPROVAL_KIND) throw refuse("There is no such approval for a credit or debit note", "NOT_FOUND");
  if (!approval.subjectRef.startsWith(`${kind}:${input.accountId}:`)) throw refuse("This approval is for another account or kind of note");
  if (approval.status !== "approved") throw refuse(`The approval is ${approval.status}; a note needs an approved request`);
  if (approval.amount !== (total < 0n ? -total : total)) throw refuse("The note's total differs from the amount that was approved");
  await assertRelated(env, kind, input, total);

  const posted = await postDraft(env, {
    kind,
    entryType: kind === "credit_note" ? "credit" : "adjustment",
    invoiceTypeId: input.invoiceTypeId,
    accountId: input.accountId,
    customerId: input.customerId ?? null,
    currency: await organizationCurrency(env.tx),
    lines,
    issuedOn: await todayOf(env.tx),
    dueOn: kind === "debit_note" ? (input.dueOn ?? null) : null,
    relatedDocumentId: input.relatedDocumentId ?? null,
    note: input.note,
    idempotencyKey: key,
    dimensions: dimensionsOf(input),
  });
  await announceNote(env, posted, approval.id, approval.reasonCode);
  return { replayed: false, document: await presentPosted(env.tx, posted.document) };
}
