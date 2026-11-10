import type { Transaction } from "@flowless/db";
import { cycle, cycleAccount, type CycleFrequency } from "@flowless/db/schema/billing";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";

/*
 * Period lock (B-15): a closed cycle locks its period for the accounts it covered. The lock
 * is the cycle's `closed` state (the database refuses anything added to it), so there is no
 * second flag to drift. A normal posting into a locked period is refused with a pointer to the
 * correction documents (B-14); credit notes, debit notes, voids and re-bills stay possible.
 */

const FREQUENCY_MONTHS: Record<CycleFrequency, number> = { monthly: 1, bimonthly: 2, quarterly: 3 };

/** Months a cycle covers: its period and the earlier months of its frequency, oldest first (YYYY-MM). */
export function monthsCovered(period: string, frequency: CycleFrequency): string[] {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const end = y * 12 + (m - 1);
  const n = FREQUENCY_MONTHS[frequency];
  return Array.from({ length: n }, (_, i) => {
    const index = end - (n - 1) + i;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
  });
}

/** The last day (YYYY-MM-DD) of a period's month. */
export function lastDayOf(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The closed cycle that locks `period` for the account, if any. */
export async function lockingCycle(tx: Transaction, accountId: string, period: string): Promise<{ id: string; period: string } | null> {
  const rows = await tx
    .select({ id: cycle.id, period: cycle.period, frequency: cycle.frequency })
    .from(cycle)
    .innerJoin(cycleAccount, and(eq(cycleAccount.organizationId, cycle.organizationId), eq(cycleAccount.cycleId, cycle.id)))
    .where(and(eq(cycle.state, "closed"), eq(cycleAccount.accountId, accountId)));
  const found = rows.find((r) => monthsCovered(r.period, r.frequency).includes(period));
  return found ? { id: found.id, period: found.period } : null;
}

/** PRECONDITION_FAILED when a closed cycle locks the account's period. */
export async function assertPeriodOpen(tx: Transaction, accountId: string, period: string): Promise<void> {
  const locked = await lockingCycle(tx, accountId, period);
  if (locked) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Period ${period} is closed (billing cycle ${locked.id} for ${locked.period}). Correct it with a credit note, a debit note or a void and re-bill (B-14), not a new invoice`,
    });
  }
}
