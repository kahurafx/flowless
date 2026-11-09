import { z } from "zod";

/*
 * Effective dating (T-01, T-03), pure: calendar dates as "YYYY-MM-DD" strings (the
 * organization's local dates), the version in force on a date, billing period starts and
 * the rule for a requested effective date. No I/O and no clock: callers pass "today".
 *
 * The model: version i is in force from its `effectiveFrom` until the next version's, so
 * versions never overlap. Two versions may share a date while it is still ahead; the one
 * with the higher `versionNo` replaces the other, which then covers no days.
 */

export type IsoDate = string;
export const isoDateSchema = z.iso.date();

export interface Dated {
  effectiveFrom: IsoDate;
  versionNo: number;
}

/** A date as a calendar date: a Date means its UTC calendar day. */
export type DateLike = IsoDate | Date;

export const toIsoDate = (d: DateLike): IsoDate => (typeof d === "string" ? d : d.toISOString().slice(0, 10));

/** A calendar date as a Date at UTC midnight, for callers that need one. */
export const fromIsoDate = (d: IsoDate): Date => new Date(`${d}T00:00:00.000Z`);

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export const daysBetween = (a: IsoDate, b: IsoDate): number => Math.round((fromIsoDate(b).getTime() - fromIsoDate(a).getTime()) / 86_400_000);

export const addDays = (d: IsoDate, days: number): IsoDate => toIsoDate(new Date(fromIsoDate(d).getTime() + days * 86_400_000));

/** Today's calendar date in an IANA time zone (the organization's, NF-33). */
export function todayIn(timeZone: string, now: Date = new Date()): IsoDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * The version in force on `on`: the latest `effectiveFrom` on or before it, the highest
 * `versionNo` among versions sharing that date. Null before the first version starts.
 * Billing uses it per reading date (the optional T-03 rule) or per sub-period (section 6).
 */
export function versionInForce<T extends Dated>(versions: readonly T[], on: DateLike): T | null {
  const day = toIsoDate(on);
  let best: T | null = null;
  for (const v of versions) {
    if (v.effectiveFrom > day) continue;
    if (!best || v.effectiveFrom > best.effectiveFrom || (v.effectiveFrom === best.effectiveFrom && v.versionNo > best.versionNo)) best = v;
  }
  return best;
}

export interface VersionSpan<T> {
  version: T;
  /** First day in force. */
  from: IsoDate;
  /** First day it is no longer in force (the next version's start); null while it is the latest. */
  until: IsoDate | null;
}

/** Each version with the days it covers, oldest first. A replaced version covers none (from = until). */
export function versionSpans<T extends Dated>(versions: readonly T[]): VersionSpan<T>[] {
  const sorted = [...versions].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : a.versionNo - b.versionNo));
  return sorted.map((version, i) => ({ version, from: version.effectiveFrom, until: sorted[i + 1]?.effectiveFrom ?? null }));
}

/* ---------- billing periods (T-03) ---------- */

/** Billing periods are calendar months that start on this day (1 to 28), so every month has one. */
export interface PeriodPolicy {
  periodStartDay: number;
}

/**
 * The first billing period start strictly after `from` (T-03's default effective date).
 * `from` is a calendar day: a Date means its UTC day, so callers pass the organization's
 * local day at UTC midnight (`fromIsoDate(todayIn(zone))`). Returns a Date at UTC midnight.
 */
export function nextPeriodStart(from: Date, policy: PeriodPolicy): Date {
  return fromIsoDate(nextPeriodStartIso(toIsoDate(from), policy));
}

export function nextPeriodStartIso(from: IsoDate, { periodStartDay }: PeriodPolicy): IsoDate {
  const [y, m, d] = from.split("-").map(Number) as [number, number, number];
  const day = String(periodStartDay).padStart(2, "0");
  if (d < periodStartDay) return `${y}-${String(m).padStart(2, "0")}-${day}`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-${day}`;
}

/* ---------- choosing an effective date ---------- */

export type EffectiveDatePlan =
  | { ok: true; effectiveFrom: IsoDate; defaulted: boolean }
  | { ok: false; reason: "closed_period" | "already_in_force"; message: string };

export interface EffectiveDateInput {
  /** What the person asked for; omitted means "the next billing period start". */
  requested?: IsoDate | undefined;
  /** The organization's date today. */
  today: IsoDate;
  policy: PeriodPolicy;
  /** The last day of the latest closed billing period (inclusive), or null when none is closed. */
  closedThrough: IsoDate | null;
  /** The effective dates already recorded for the thing being versioned. */
  existing: readonly IsoDate[];
  /** True for the first version of something new, which starts today rather than at the next period. */
  first?: boolean;
}

/**
 * Decides the effective date of a new version (T-03): the requested one, else the next
 * billing period start (today for a first version). A date on or before the last closed
 * period is refused. A date that already has a version is refused once it has arrived
 * (that version has been in force and cannot be rewritten); while it is still ahead the new
 * version replaces it.
 */
export function planEffectiveDate(input: EffectiveDateInput): EffectiveDatePlan {
  const defaulted = input.requested === undefined;
  const effectiveFrom = input.requested ?? (input.first ? input.today : nextPeriodStartIso(input.today, input.policy));
  if (input.closedThrough !== null && effectiveFrom <= input.closedThrough) {
    return { ok: false, reason: "closed_period", message: `${effectiveFrom} is inside a closed billing period (closed through ${input.closedThrough}); a change must start after it` };
  }
  if (effectiveFrom <= input.today && input.existing.includes(effectiveFrom)) {
    return { ok: false, reason: "already_in_force", message: `A version already takes effect on ${effectiveFrom}, which has arrived; choose a later date` };
  }
  return { ok: true, effectiveFrom, defaulted };
}
