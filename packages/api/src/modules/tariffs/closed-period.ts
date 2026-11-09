import type { Transaction } from "@flowless/db";

/*
 * The closed-period port (T-03, B-15). Billing periods do not exist until Phase 4, so
 * Tariffs asks a replaceable source for the last day of the organization's latest closed
 * period and refuses a tariff, category or charge-amount change that starts on or before it.
 * Until a source is registered nobody has a closed period.
 *
 * Billing registers its own source once, at start-up, through the module's published
 * interface (`registerClosedPeriodSource`, never by importing this file).
 */

/** The last day (inclusive, a UTC calendar date) of the organization's latest closed period, or null. */
export type ClosedPeriodSource = (tx: Transaction, organizationId: string) => Promise<Date | null>;

const none: ClosedPeriodSource = async () => null;
let source: ClosedPeriodSource = none;

export function closedThrough(tx: Transaction, organizationId: string): Promise<Date | null> {
  return source(tx, organizationId);
}

/** Replaces the source; pass null to go back to "nothing is closed" (tests do). */
export function registerClosedPeriodSource(next: ClosedPeriodSource | null): void {
  source = next ?? none;
}
