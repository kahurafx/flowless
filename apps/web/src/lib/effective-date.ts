/*
 * What date a tariff, category or charge change takes effect (T-03), for the form before it
 * is saved. A mirror of the Tariffs module's pure `planEffectiveDate`: the server decides
 * and refuses, this only says so early and plainly. Dates are `YYYY-MM-DD` in the
 * organization's time zone.
 */

export interface NextEffective {
  today: string;
  /** The next billing period start (`tariffs.nextEffectiveDate`). */
  effectiveFrom: string;
  periodStartDay: number;
  /** The last day of the latest closed billing period, or null. */
  closedThrough: string | null;
}

export type EffectivePreview =
  | { kind: "default"; date: string; message: string }
  | { kind: "ok"; date: string; message: string }
  | { kind: "replaces"; date: string; message: string }
  | { kind: "refused"; reason: "closed_period" | "already_in_force" | "invalid"; message: string };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date as people read it ("12 Jan 2027"), without touching the clock or a time zone. */
export function plainDate(iso: string, locale = "en-GB"): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/**
 * The preview line under the effective-date input. `typed` is what is in the input ("" for
 * the default), `existing` the dates already recorded for the thing being versioned, and
 * `first` is true for a first version (which starts today by default).
 */
export function previewEffectiveDate(input: { typed: string; next: NextEffective; existing: readonly string[]; first?: boolean; locale?: string }): EffectivePreview {
  const { next } = input;
  const typed = input.typed.trim();
  const say = (iso: string) => plainDate(iso, input.locale);
  if (typed !== "" && !ISO.test(typed)) return { kind: "refused", reason: "invalid", message: "Enter the date as day, month and year" };
  const date = typed === "" ? (input.first ? next.today : next.effectiveFrom) : typed;
  if (next.closedThrough !== null && date <= next.closedThrough) {
    return { kind: "refused", reason: "closed_period", message: `${say(date)} is inside a closed billing period (closed through ${say(next.closedThrough)}). A change must start after it.` };
  }
  if (date <= next.today && input.existing.includes(date)) {
    return { kind: "refused", reason: "already_in_force", message: `A version already takes effect on ${say(date)}, which has arrived. Choose a later date.` };
  }
  if (typed === "") {
    return {
      kind: "default",
      date,
      message: input.first ? `Takes effect today, ${say(date)}.` : `Takes effect on ${say(date)}, the next billing period start (the ${ordinal(next.periodStartDay)} of the month).`,
    };
  }
  if (input.existing.includes(date)) return { kind: "replaces", date, message: `Takes effect on ${say(date)}. A version already scheduled for that day is replaced; the history keeps both.` };
  return { kind: "ok", date, message: date <= next.today ? `Takes effect on ${say(date)}, which has passed: it is back-dated.` : `Takes effect on ${say(date)}.` };
}
