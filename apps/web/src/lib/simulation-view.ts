/*
 * Tariff simulation helpers (T-06). Pure. The API validates the draft with the same shared rules
 * and prices with the billing engine; this only reads the selection from a form and describes a delta.
 */

/** Account numbers typed or pasted, separated by commas, spaces or new lines; duplicates dropped. */
export function parseAccountNumbers(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean))];
}

export interface SimulationSelection {
  routeId: string;
  categoryId: string;
  accountNumbers: string;
}

/** At least one way to choose accounts, as the API requires. */
export function selectionProblem(s: SimulationSelection): string | null {
  return s.routeId || s.categoryId || parseAccountNumbers(s.accountNumbers).length > 0 ? null : "Choose a route, a category or some account numbers to simulate";
}

/** "+12.50 a month on average" style direction for a signed delta in minor units. */
export function deltaDirection(delta: bigint): "up" | "down" | "same" {
  return delta > 0n ? "up" : delta < 0n ? "down" : "same";
}

/** Percent change of `draft` against `current`, one decimal, integer arithmetic; null when nothing was priced. */
export function percentChange(current: bigint, draft: bigint): string | null {
  if (current === 0n) return null;
  const tenths = ((draft - current) * 1000n) / (current < 0n ? -current : current);
  const sign = tenths > 0n ? "+" : tenths < 0n ? "-" : "";
  const abs = tenths < 0n ? -tenths : tenths;
  return `${sign}${abs / 10n}.${abs % 10n}%`;
}
