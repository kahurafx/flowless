import { READING_FLAGS, type ReadingFlag } from "@flowless/shared-types";
import type { MeteringValidation } from "./settings";

/*
 * M-05 and M-07, pure: given the neighbours of a new reading, which flags does it raise?
 * No I/O. The caller gathers the neighbours (derived, never stored) and applies the result.
 */

export interface Neighbour {
  value: number;
  readAt: Date;
}

export interface ValidationInput {
  value: number;
  readAt: Date;
  dialDigits: number;
  purpose: "routine" | "initial" | "final";
  /** The technician already confirmed the dial wrapped (M-07). */
  rolloverConfirmed: boolean;
  /** The latest cleared actual reading of this meter before `readAt`; null when there is none. */
  previous: Neighbour | null;
  /** The earliest cleared actual reading after `readAt` (a back-dated entry); null when none. */
  next: Neighbour | null;
  /** Cleared actual readings before `previous`, newest first, for the expected range. */
  history: readonly Neighbour[];
  /** Another live reading of this meter on the same local day. */
  sameDayDuplicate: boolean;
  /** `readAt` falls on or before the last day of the latest closed period (M-11). */
  inClosedPeriod: boolean;
}

export interface ValidationResult {
  flags: ReadingFlag[];
  /** Units used since `previous`, counting a wrap when it is (or is taken to be) a rollover. */
  units: number | null;
  /** The reading is a wrap of the dial, confirmed. */
  rollover: boolean;
}

const DAY_MS = 86_400_000;
const days = (from: Date, to: Date) => Math.max((to.getTime() - from.getTime()) / DAY_MS, 1 / 24);

export function validateReading(input: ValidationInput, config: MeteringValidation): ValidationResult {
  const flags = new Set<ReadingFlag>();
  const capacity = 10 ** input.dialDigits;
  const { previous } = input;
  let units: number | null = null;
  let rollover = false;

  if (input.sameDayDuplicate && input.purpose === "routine") flags.add("SAME_DAY_DUPLICATE");
  if (input.inClosedPeriod) flags.add("CLOSED_PERIOD");

  // A new meter's first reading and an old meter's last are boundaries: no zero or range checks.
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
        // A confirmation that the arithmetic cannot support is not accepted silently.
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
    const expected = expectedPerDay(previous, input.history, config.historyIntervals);
    if (expected !== null && expected > 0) {
      const perDay = units / elapsed;
      if (perDay > expected * config.highFactor) flags.add("ABOVE_RANGE");
      if (config.lowFactor > 0 && units > 0 && perDay < expected * config.lowFactor) flags.add("BELOW_RANGE");
    }
  }

  return { flags: [...flags].sort(), units, rollover };
}

/** Mean daily consumption over the last `n` intervals ending at `previous`; null with no interval to learn from. */
export function expectedPerDay(previous: Neighbour, history: readonly Neighbour[], n: number): number | null {
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

/** Does this set of flags keep a reading out of automatic billing? */
export const blocks = (flags: readonly string[]): boolean => flags.some((f) => (READING_FLAGS as Record<string, { blocking: boolean }>)[f]?.blocking ?? true);
