import type { Transaction } from "@flowless/db";
import { document, documentLine, ledgerEntry, ledgerTransaction, type DocumentKind, type LedgerEntryType } from "@flowless/db/schema/billing";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import type { ActionEnv } from "../../kernel/action-env";
import { allocateInvoiceNumber } from "../tariffs";
import { counterAccount, spanOf, sumLines, type DraftLine } from "./mapping";

/*
 * The one place that writes documents and ledger entries (B-10, B-11, NF-22). Everything is
 * an INSERT; the database refuses an UPDATE or DELETE, an unbalanced posting and lines that
 * do not sum to the total. Callers hold the account's lock (`lockAccount`) so postings for
 * one account take turns.
 */

export type DocumentRow = typeof document.$inferSelect;
export type DocumentLineRow = typeof documentLine.$inferSelect;

/** The snapshot of where the money belongs, taken at posting (B-17). All opaque ids. */
export interface Dimensions {
  servicePointId?: string | null;
  schemeId?: string | null;
  zoneId?: string | null;
  categoryId?: string | null;
}

export interface Draft {
  kind: DocumentKind;
  entryType: LedgerEntryType;
  invoiceTypeId: string;
  accountId: string;
  customerId?: string | null;
  currency: string;
  lines: readonly DraftLine[];
  issuedOn: string;
  dueOn?: string | null;
  relatedDocumentId?: string | null;
  reversesDocumentId?: string | null;
  replacesDocumentId?: string | null;
  note?: string | null;
  idempotencyKey: string;
  /** The final bill of a disconnection (B-12). */
  finalBill?: boolean;
  dimensions?: Dimensions;
  /** For a reversal: the ledger transaction it mirrors (null when the original posted no entries). */
  mirrorOf?: string | null;
}

/** Postings for one account take turns (a transaction-scoped advisory lock). */
export async function lockAccount(tx: Transaction, accountId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${accountId}`}, 0))`);
}

export async function documentByKey(tx: Transaction, key: string): Promise<DocumentRow | undefined> {
  const [row] = await tx.select().from(document).where(eq(document.idempotencyKey, key));
  return row;
}

export async function documentById(tx: Transaction, id: string): Promise<DocumentRow> {
  const [row] = await tx.select().from(document).where(eq(document.id, id));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
  return row;
}

export async function linesOf(tx: Transaction, documentId: string): Promise<DocumentLineRow[]> {
  return tx.select().from(documentLine).where(eq(documentLine.documentId, documentId)).orderBy(asc(documentLine.position));
}

export async function postDraft(env: ActionEnv, draft: Draft): Promise<{ document: DocumentRow; lines: DocumentLineRow[]; transactionId: string | null }> {
  const { tx, organizationId } = env;
  if (draft.lines.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "A document needs at least one line" });
  const number = await allocateInvoiceNumber(tx, organizationId, draft.invoiceTypeId);
  const total = sumLines(draft.lines);
  const span = spanOf(draft.lines);
  const [doc] = await tx
    .insert(document)
    .values({
      organizationId,
      kind: draft.kind,
      invoiceTypeId: draft.invoiceTypeId,
      number: number.number,
      numberSequence: number.sequence,
      accountId: draft.accountId,
      customerId: draft.customerId ?? null,
      currency: draft.currency,
      total,
      lineCount: draft.lines.length,
      issuedOn: draft.issuedOn,
      dueOn: draft.dueOn ?? null,
      periodFrom: span.periodFrom,
      periodTo: span.periodTo,
      relatedDocumentId: draft.relatedDocumentId ?? null,
      reversesDocumentId: draft.reversesDocumentId ?? null,
      replacesDocumentId: draft.replacesDocumentId ?? null,
      idempotencyKey: draft.idempotencyKey,
      finalBill: draft.finalBill ?? false,
      note: draft.note ?? null,
      createdByUserId: env.actor.userId,
    })
    .returning();
  const lines = await tx
    .insert(documentLine)
    .values(
      draft.lines.map((l, position) => ({
        organizationId,
        documentId: doc!.id,
        position,
        lineType: l.lineType,
        description: l.description,
        quantity: l.quantity ?? null,
        unitRate: l.unitRate ?? null,
        amount: l.amount,
        serviceFrom: l.serviceFrom ?? null,
        serviceTo: l.serviceTo ?? null,
        tariffVersionId: l.tariffVersionId ?? null,
        chargeItemId: l.chargeItemId ?? null,
        chargeItemAmountId: l.chargeItemAmountId ?? null,
        chargeType: l.chargeType ?? null,
        calculation: l.calculation ?? null,
      })),
    )
    .returning();
  const transactionId = await postEntries(env, draft, doc!);
  return { document: doc!, lines: lines.sort((a, b) => a.position - b.position), transactionId };
}

type EntryValues = typeof ledgerEntry.$inferInsert;

async function postEntries(env: ActionEnv, draft: Draft, doc: DocumentRow): Promise<string | null> {
  const { tx, organizationId } = env;
  const base = { organizationId, currency: draft.currency, accountId: draft.accountId, invoiceTypeId: draft.invoiceTypeId, documentId: doc.id, ...draft.dimensions };
  let entries: Omit<EntryValues, "transactionId">[];
  if (draft.mirrorOf !== undefined) {
    // A reversal mirrors the original entries: same amounts and dimensions, opposite sides, tied to the mirrored line.
    if (draft.mirrorOf === null) return null;
    const original = await tx.select().from(ledgerEntry).where(eq(ledgerEntry.transactionId, draft.mirrorOf)).orderBy(asc(ledgerEntry.lineNo));
    entries = original.map((e) => ({
      organizationId,
      lineNo: e.lineNo,
      currency: e.currency,
      side: e.side === "debit" ? ("credit" as const) : ("debit" as const),
      amount: e.amount,
      ledgerAccount: e.ledgerAccount,
      accountId: e.accountId,
      servicePointId: e.servicePointId,
      schemeId: e.schemeId,
      zoneId: e.zoneId,
      categoryId: e.categoryId,
      chargeItemId: e.chargeItemId,
      chargeType: e.chargeType,
      invoiceTypeId: e.invoiceTypeId,
      paymentChannel: e.paymentChannel,
      serviceFrom: e.serviceFrom,
      serviceTo: e.serviceTo,
      tariffVersionId: e.tariffVersionId,
      chargeItemAmountId: e.chargeItemAmountId,
      documentId: e.documentLinePosition === null ? null : doc.id,
      documentLinePosition: e.documentLinePosition,
    }));
  } else {
    entries = [];
    draft.lines.forEach((l, position) => {
      if (l.amount === 0n) return;
      const abs = l.amount < 0n ? -l.amount : l.amount;
      const receivableSide = l.amount > 0n ? ("debit" as const) : ("credit" as const);
      const common = {
        ...base,
        amount: abs,
        servicePointId: draft.dimensions?.servicePointId ?? null,
        chargeItemId: l.chargeItemId ?? null,
        chargeType: l.chargeType ?? null,
        serviceFrom: l.serviceFrom ?? null,
        serviceTo: l.serviceTo ?? null,
        tariffVersionId: l.tariffVersionId ?? null,
        chargeItemAmountId: l.chargeItemAmountId ?? null,
        documentLinePosition: position,
      };
      entries.push({ ...common, lineNo: entries.length, side: receivableSide, ledgerAccount: "receivable" });
      entries.push({ ...common, lineNo: entries.length, side: receivableSide === "debit" ? "credit" : "debit", ledgerAccount: counterAccount(l.lineType) });
    });
  }
  if (entries.length === 0) return null;
  const [header] = await tx
    .insert(ledgerTransaction)
    .values({
      organizationId,
      entryType: draft.entryType,
      currency: draft.currency,
      entryCount: entries.length,
      effectiveOn: draft.issuedOn,
      documentId: doc.id,
      reversesTransactionId: draft.mirrorOf ?? null,
      idempotencyKey: `${draft.idempotencyKey}:ledger`,
      description: `${draft.kind} ${doc.number}`,
      createdByUserId: env.actor.userId,
    })
    .returning({ id: ledgerTransaction.id });
  await tx.insert(ledgerEntry).values(entries.map((e) => ({ ...e, transactionId: header!.id })));
  return header!.id;
}

/** The ledger transaction posted under this idempotency key, if any. */
export async function transactionKeyed(tx: Transaction, key: string): Promise<string | null> {
  const [row] = await tx.select({ id: ledgerTransaction.id }).from(ledgerTransaction).where(eq(ledgerTransaction.idempotencyKey, key));
  return row?.id ?? null;
}

/** The ledger transaction that posted a document, if it posted any entry. */
export async function transactionOf(tx: Transaction, documentId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: ledgerTransaction.id })
    .from(ledgerTransaction)
    .where(and(eq(ledgerTransaction.documentId, documentId), sql`${ledgerTransaction.entryType} <> 'reversal'`));
  return row?.id ?? null;
}
