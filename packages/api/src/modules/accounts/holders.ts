import type { Transaction } from "@flowless/db";
import { accountHolder } from "@flowless/db/schema/accounts";
import { and, desc, eq, gt, lte } from "drizzle-orm";
import { readSetting } from "../../kernel/config-store";
import { regionalSetting } from "../../kernel/regional";

/*
 * The holder history of an account (C-10). `account_holder` is insert-only: a row is the
 * holder from its `valid_from` until the next row's. The account's own `customer_id` is the
 * current holder and the database lets it change only to the newest row's customer.
 */

export interface HolderPeriod {
  customerId: string;
  /** YYYY-MM-DD. */
  validFrom: string;
  /** The day the next holder took over (exclusive end), or null for the current holder. */
  validTo: string | null;
  /** The closing reading taken for the PREVIOUS holder when this one took over; opaque until Metering. */
  previousClosingReadingRef: string | null;
  commandId: string | null;
}

/** A holder row: the first holder of a new account, or the new holder of a change of name from `validFrom`. */
export async function insertHolder(
  tx: Transaction,
  args: { organizationId: string; accountId: string; customerId: string; validFrom: string; userId: string | null; commandId?: string | null; reason: string; previousClosingReadingRef?: string | null },
): Promise<void> {
  await tx.insert(accountHolder).values({
    organizationId: args.organizationId,
    accountId: args.accountId,
    customerId: args.customerId,
    validFrom: args.validFrom,
    commandId: args.commandId ?? null,
    previousClosingReadingRef: args.previousClosingReadingRef ?? null,
    reason: args.reason,
    createdByUserId: args.userId,
  });
}

/** The newest holder row of an account (the current holder). */
export async function currentHolder(tx: Transaction, accountId: string) {
  const [row] = await tx
    .select()
    .from(accountHolder)
    .where(eq(accountHolder.accountId, accountId))
    .orderBy(desc(accountHolder.validFrom), desc(accountHolder.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Who held the account on `date` (YYYY-MM-DD): the holder whose period contains it, or null
 * when the date is before the first holder's. Published for Billing, which splits a bill at
 * a change of name; `tx` is a tenant transaction.
 */
export async function holderAt(tx: Transaction, accountId: string, date: string): Promise<HolderPeriod | null> {
  const [row] = await tx
    .select()
    .from(accountHolder)
    .where(and(eq(accountHolder.accountId, accountId), lte(accountHolder.validFrom, date)))
    .orderBy(desc(accountHolder.validFrom), desc(accountHolder.createdAt))
    .limit(1);
  if (!row) return null;
  const [next] = await tx
    .select({ validFrom: accountHolder.validFrom })
    .from(accountHolder)
    .where(and(eq(accountHolder.accountId, accountId), gt(accountHolder.validFrom, row.validFrom)))
    .orderBy(accountHolder.validFrom)
    .limit(1);
  return {
    customerId: row.customerId,
    validFrom: row.validFrom,
    validTo: next?.validFrom ?? null,
    previousClosingReadingRef: row.previousClosingReadingRef,
    commandId: row.commandId,
  };
}

/** Every holder of the account, oldest first, each with the day the next took over. */
export async function holdersOf(tx: Transaction, accountId: string): Promise<HolderPeriod[]> {
  const rows = await tx.select().from(accountHolder).where(eq(accountHolder.accountId, accountId)).orderBy(accountHolder.validFrom, accountHolder.createdAt);
  return rows.map((row, i) => ({
    customerId: row.customerId,
    validFrom: row.validFrom,
    validTo: rows[i + 1]?.validFrom ?? null,
    previousClosingReadingRef: row.previousClosingReadingRef,
    commandId: row.commandId,
  }));
}

/** Today as YYYY-MM-DD in the organization's time zone (`kernel.regional`). */
export async function localToday(tx: Transaction, now: Date = new Date()): Promise<string> {
  const { timeZone } = (await readSetting(tx, regionalSetting)).value;
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
