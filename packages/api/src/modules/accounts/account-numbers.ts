import type { Transaction } from "@flowless/db";
import { account, accountCounter } from "@flowless/db/schema/accounts";
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { childAccountNumber, formatAccountNumber, suffixLetters, type NumberingFormat } from "./numbering";

/*
 * Issuing account numbers (C-02): the counter rows behind them. The format itself is pure and
 * lives in `numbering.ts`.
 */

const MAX_SKIPS = 200;

/**
 * Takes the next value of a counter. One statement: the row is created or updated, and its
 * lock is held until the transaction ends, so two creates at once take turns and never see
 * the same value (never MAX+1). A rolled-back create gives its value back.
 */
async function takeFromCounter(tx: Transaction, organizationId: string, scope: string, start: number): Promise<number> {
  const rows = await tx.execute<{ allocated: string }>(sql`
    insert into accounts.account_counter as c (organization_id, scope, next_value)
    values (${organizationId}, ${scope}, ${start + 1})
    on conflict (organization_id, scope) do update set next_value = greatest(c.next_value, ${start}::bigint) + 1
    returning next_value - 1 as allocated`);
  return Number(rows[0]!.allocated);
}

const numberTaken = async (tx: Transaction, number: string) =>
  (await tx.select({ id: account.id }).from(account).where(eq(account.number, number)).limit(1)).length > 0;

/**
 * The next free account number of the organization. Sequences that have no valid check
 * digit (mod 11, one in eleven) or whose number is already used (the format changed) are
 * skipped, so a gap in the sequence is possible and harmless.
 */
export async function issueAccountNumber(tx: Transaction, organizationId: string, format: NumberingFormat): Promise<string> {
  for (let i = 0; i < MAX_SKIPS; i++) {
    const sequence = await takeFromCounter(tx, organizationId, "main", format.start);
    const number = formatAccountNumber(sequence, format);
    if (number !== null && !(await numberTaken(tx, number))) return number;
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "No free account number found: check the numbering format" });
}

/** A child's number under `parent`: the parent's number plus the next letters, counted per parent. */
export async function issueChildNumber(tx: Transaction, organizationId: string, parent: { id: string; number: string }): Promise<{ number: string; suffixIndex: number }> {
  for (let i = 0; i < MAX_SKIPS; i++) {
    const suffixIndex = await takeFromCounter(tx, organizationId, `child:${parent.id}`, 1);
    const number = childAccountNumber(parent.number, suffixIndex);
    if (!(await numberTaken(tx, number))) return { number, suffixIndex };
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "No free child number found" });
}

/** What the next number would be, without taking it (another create may take it first). */
export async function previewNextNumber(tx: Transaction, format: NumberingFormat, parent?: { id: string; number: string }): Promise<string> {
  const scope = parent ? `child:${parent.id}` : "main";
  const start = parent ? 1 : format.start;
  const [counter] = await tx.select({ next: accountCounter.nextValue }).from(accountCounter).where(eq(accountCounter.scope, scope));
  for (let sequence = Math.max(counter?.next ?? start, start), i = 0; i < MAX_SKIPS; sequence++, i++) {
    const number = parent ? `${parent.number}${suffixLetters(sequence)}` : formatAccountNumber(sequence, format);
    if (number !== null && !(await numberTaken(tx, number))) return number;
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "No free account number found: check the numbering format" });
}
