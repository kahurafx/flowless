import type { Transaction } from "@flowless/db";
import { document } from "@flowless/db/schema/billing";
import { addDays } from "@flowless/shared-types";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { documentById, linesOf } from "./post";
import { toDocumentDto, toLineDto } from "./present";
import { organizationCurrency } from "./usage";

/*
 * Derived reads (I-2, B-11): the balance, the statement and its running total are computed
 * from ledger entries when asked and never stored. The customer's balance is receivable
 * debits minus credits, so a positive balance is what the customer owes.
 */

const NO_ACCOUNT = "00000000-0000-0000-0000-000000000000";
const SIGNED = sql`case e.side when 'debit' then e.amount else -e.amount end`;

/** What the account owes, optionally as of a date (by the date postings count for). */
export async function accountBalance(tx: Transaction, accountId: string, asOf?: string) {
  const rows = await tx.execute<{ balance: string | null }>(sql`
    select sum(${SIGNED})::text as balance
      from billing.ledger_entry e
      join billing.ledger_transaction t on t.organization_id = e.organization_id and t.id = e.transaction_id
     where e.account_id = ${accountId} and e.ledger_account = 'receivable'
       ${asOf ? sql`and t.effective_on <= ${asOf}` : sql``}`);
  return { accountId, currency: await organizationCurrency(tx), balance: BigInt(rows[0]?.balance ?? "0"), asOf: asOf ?? null };
}

export interface StatementRow {
  transactionId: string;
  effectiveOn: string;
  postedAt: Date;
  entryType: string;
  documentId: string | null;
  documentKind: string | null;
  documentNumber: string | null;
  description: string | null;
  /** Debit (owes more) positive, credit negative. */
  amount: bigint;
  /** The balance after this row, over the account's whole history in posting order. */
  runningBalance: bigint;
}

/**
 * The statement: one row per ledger transaction that moved the receivable, in posting order
 * (effective date, then time written), with the running total computed over the whole history
 * so a window starts from the right opening balance.
 */
export async function accountStatement(tx: Transaction, accountId: string, window: { from?: string; to?: string; limit: number; offset: number }) {
  const rows = await tx.execute<{
    transaction_id: string;
    effective_on: string;
    posted_at: Date | string;
    entry_type: string;
    document_id: string | null;
    document_kind: string | null;
    document_number: string | null;
    description: string | null;
    amount: string;
    running: string;
  }>(sql`
    with moves as (
      select t.id as transaction_id, t.effective_on::text as effective_on, t.posted_at, t.entry_type, t.document_id, t.description,
             sum(${SIGNED}) as amount
        from billing.ledger_entry e
        join billing.ledger_transaction t on t.organization_id = e.organization_id and t.id = e.transaction_id
       where e.account_id = ${accountId} and e.ledger_account = 'receivable'
       group by t.id
    ), running as (
      select m.*, sum(m.amount) over (order by m.effective_on, m.posted_at, m.transaction_id) as running from moves m
    )
    select r.transaction_id, r.effective_on, r.posted_at, r.entry_type, r.document_id, d.kind as document_kind, d.number as document_number,
           r.description, r.amount::text as amount, r.running::text as running
      from running r left join billing.document d on d.id = r.document_id
     where true
       ${window.from ? sql`and r.effective_on >= ${window.from}` : sql``}
       ${window.to ? sql`and r.effective_on <= ${window.to}` : sql``}
     order by r.effective_on, r.posted_at, r.transaction_id
     limit ${window.limit} offset ${window.offset}`);
  const items: StatementRow[] = rows.map((r) => ({
    transactionId: r.transaction_id,
    effectiveOn: r.effective_on,
    postedAt: new Date(r.posted_at),
    entryType: r.entry_type,
    documentId: r.document_id,
    documentKind: r.document_kind,
    documentNumber: r.document_number,
    description: r.description,
    amount: BigInt(r.amount),
    runningBalance: BigInt(r.running),
  }));
  const first = items[0];
  return {
    accountId,
    currency: await organizationCurrency(tx),
    openingBalance: first ? first.runningBalance - first.amount : window.from ? (await accountBalance(tx, accountId, addDays(window.from, -1))).balance : 0n,
    closingBalance: items.at(-1)?.runningBalance ?? null,
    items,
  };
}

/** A document with its lines and its links, as the office sees it. */
export async function documentWithLines(tx: Transaction, id: string) {
  const d = await documentById(tx, id);
  const lines = await linesOf(tx, id);
  const [reversedBy] = await tx.select({ id: document.id }).from(document).where(eq(document.reversesDocumentId, id));
  const [replacedBy] = await tx.select({ id: document.id }).from(document).where(eq(document.replacesDocumentId, id));
  const notes = await tx.select({ id: document.id, kind: document.kind, number: document.number, total: document.total }).from(document).where(eq(document.relatedDocumentId, id));
  return { ...toDocumentDto(d), lines: lines.map(toLineDto), reversedByDocumentId: reversedBy?.id ?? null, replacedByDocumentId: replacedBy?.id ?? null, notes };
}

export async function listDocuments(tx: Transaction, filter: { accountId?: string | undefined; accountIds?: string[] | undefined; kind?: (typeof document.$inferSelect)["kind"] | undefined; before?: Date | undefined; limit: number }) {
  const rows = await tx
    .select()
    .from(document)
    .where(and(filter.accountId ? eq(document.accountId, filter.accountId) : undefined, filter.accountIds ? inArray(document.accountId, filter.accountIds.length ? filter.accountIds : [NO_ACCOUNT]) : undefined, filter.kind ? eq(document.kind, filter.kind) : undefined, filter.before ? lt(document.createdAt, filter.before) : undefined))
    .orderBy(desc(document.createdAt), desc(document.id))
    .limit(filter.limit);
  return rows.map(toDocumentDto);
}
