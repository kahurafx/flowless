import { isBlockingFlag, READING_FLAGS, type ReadingFlag } from "./metering";

/*
 * M-05 and M-07 at the point of entry, pure: the same checks Metering runs on the server
 * (`validateReading` in packages/api/src/modules/metering/validate.ts), so the field app can tell the
 * reader what the server will say before the reading leaves the phone. The server stays the
 * authority; `validate-parity.test.ts` in packages/api keeps this port equal to it.
 */

/** The `metering.validation` setting's shape and defaults. */
export interface ReadingValidationConfig {
  highFactor: number;
  lowFactor: number;
  historyIntervals: number;
  maxUnitsPerDay: number | null;
  rolloverMaxFraction: number;
}
export const DEFAULT_READING_VALIDATION: ReadingValidationConfig = { highFactor: 3, lowFactor: 0, historyIntervals: 3, maxUnitsPerDay: null, rolloverMaxFraction: 0.5 };

export interface ReadingNeighbour {
  value: number;
  readAt: Date;
}

export interface ReadingEntryInput {
  value: number;
  readAt: Date;
  dialDigits: number;
  purpose: "routine" | "initial" | "final";
  rolloverConfirmed: boolean;
  previous: ReadingNeighbour | null;
  next: ReadingNeighbour | null;
  /** Cleared actual readings before `previous`, newest first. */
  history: readonly ReadingNeighbour[];
  sameDayDuplicate: boolean;
  inClosedPeriod: boolean;
}

export interface ReadingEntryResult {
  flags: ReadingFlag[];
  units: number | null;
  rollover: boolean;
}

const DAY_MS = 86_400_000;
const days = (from: Date, to: Date) => Math.max((to.getTime() - from.getTime()) / DAY_MS, 1 / 24);

export function validateReadingEntry(input: ReadingEntryInput, config: ReadingValidationConfig = DEFAULT_READING_VALIDATION): ReadingEntryResult {
  const flags = new Set<ReadingFlag>();
  const capacity = 10 ** input.dialDigits;
  const { previous } = input;
  let units: number | null = null;
  let rollover = false;

  if (input.sameDayDuplicate && input.purpose === "routine") flags.add("SAME_DAY_DUPLICATE");
  if (input.inClosedPeriod) flags.add("CLOSED_PERIOD");

  const boundary = input.purpose !== "routine";
  if (input.value === 0 && !boundary) flags.add("ZERO");

  if (previous && input.purpose !== "initial") {
    if (input.value >= previous.value) {
      units = input.value - previous.value;
    } else {
      const wrapped = capacity - previous.value + input.value;
      const plausible = wrapped < capacity * config.rolloverMaxFraction;
      if (input.rolloverConfirmed && plausible) {
        rollover = true;
        units = wrapped;
      } else if (input.rolloverConfirmed) {
        flags.add("BELOW_LAST");
      } else {
        flags.add(plausible ? "ROLLOVER_CANDIDATE" : "BELOW_LAST");
      }
    }
  }

  if (input.next && input.value > input.next.value && !rollover) flags.add("OUT_OF_SEQUENCE");

  if (units !== null && previous && !boundary) {
    const elapsed = days(previous.readAt, input.readAt);
    if (units === 0) flags.add("ZERO_CONSUMPTION");
    if (config.maxUnitsPerDay !== null && units / elapsed > config.maxUnitsPerDay) flags.add("ABOVE_RANGE");
    const expected = expectedUnitsPerDay(previous, input.history, config.historyIntervals);
    if (expected !== null && expected > 0) {
      const perDay = units / elapsed;
      if (perDay > expected * config.highFactor) flags.add("ABOVE_RANGE");
      if (config.lowFactor > 0 && units > 0 && perDay < expected * config.lowFactor) flags.add("BELOW_RANGE");
    }
  }

  return { flags: [...flags].sort() as ReadingFlag[], units, rollover };
}

/** Mean daily consumption over the last `n` intervals ending at `previous`; null with no interval to learn from. */
export function expectedUnitsPerDay(previous: ReadingNeighbour, history: readonly ReadingNeighbour[], n: number): number | null {
  let newer = previous;
  let total = 0;
  let elapsed = 0;
  let used = 0;
  for (const older of history) {
    if (used >= n) break;
    const units = newer.value - older.value;
    if (units >= 0) {
      total += units;
      elapsed += days(older.readAt, newer.readAt);
      used++;
    }
    newer = older;
  }
  return used === 0 ? null : total / elapsed;
}

/**
 * The hint under the dial: the dial values that raise no range flag at `readAt`, from the previous
 * reading and its history. `max` is null when there is nothing to learn from (no interval and no
 * absolute ceiling); `min` is the previous value, plus the low-factor floor when one is set.
 */
export function expectedDialRange(
  previous: ReadingNeighbour | null,
  history: readonly ReadingNeighbour[],
  readAt: Date,
  config: ReadingValidationConfig = DEFAULT_READING_VALIDATION,
): { min: number; max: number | null; perDay: number | null } | null {
  if (!previous) return null;
  const elapsed = days(previous.readAt, readAt);
  const perDay = expectedUnitsPerDay(previous, history, config.historyIntervals);
  const ceilings: number[] = [];
  if (perDay !== null && perDay > 0) ceilings.push(Math.floor(perDay * config.highFactor * elapsed));
  if (config.maxUnitsPerDay !== null) ceilings.push(Math.floor(config.maxUnitsPerDay * elapsed));
  const floor = perDay !== null && perDay > 0 && config.lowFactor > 0 ? Math.ceil(perDay * config.lowFactor * elapsed) : 0;
  return { min: previous.value + floor, max: ceilings.length ? previous.value + Math.min(...ceilings) : null, perDay };
}

/** Split a result's flags into the ones that hold a reading out of billing and the ones that only inform. */
export function splitFlags(flags: readonly string[]): { blocking: string[]; advisory: string[] } {
  return { blocking: flags.filter(isBlockingFlag), advisory: flags.filter((f) => !isBlockingFlag(f)) };
}

export const readingFlagLabel = (flag: string): string => (READING_FLAGS as Record<string, { label: string }>)[flag]?.label ?? flag;

/** Parse what the reader typed on the dial: digits only, within the register's width. */
export function parseDialValue(text: string, dialDigits: number): { ok: true; value: number } | { ok: false; error: string } {
  const t = text.trim();
  if (t === "") return { ok: false, error: "Enter the number on the dial" };
  if (!/^\d+$/.test(t)) return { ok: false, error: "Digits only: leave out spaces, commas and decimals" };
  if (t.length > dialDigits) return { ok: false, error: `This dial has ${dialDigits} digit${dialDigits === 1 ? "" : "s"}` };
  return { ok: true, value: Number(t) };
}
