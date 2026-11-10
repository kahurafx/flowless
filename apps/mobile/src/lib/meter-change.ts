import { parseDialValue, validateReadingEntry } from "@flowless/shared-types";
import type { RoundTask } from "./readings";

/**
 * Local checks for a meter change (M-07). The old meter's final reading is checked against its last
 * actual reading like any other (a drop must be a confirmed wrap), but skips the zero and range
 * checks, as the server does for `final`. The new meter's first reading only has to fit its dial.
 */
export type MeterChangeCheck =
  | { ok: true; finalValue: number; initialValue: number; finalError?: undefined; initialError?: undefined; finalNeedsRollover: boolean }
  | { ok: false; finalValue?: number; initialValue?: number; finalError?: string; initialError?: string; finalNeedsRollover: boolean };

export function checkMeterChange(
  task: Pick<RoundTask, "meter" | "previous" | "history">,
  newMeter: { dialDigits: number } | null,
  finalText: string,
  finalRolloverConfirmed: boolean,
  initialText: string,
  reason: string,
  now: Date,
): MeterChangeCheck {
  let finalError: string | undefined;
  let finalValue: number | undefined;
  let finalNeedsRollover = false;
  if (finalText.trim() !== "") {
    const parsed = parseDialValue(finalText, task.meter?.dialDigits ?? 12);
    if (!parsed.ok) finalError = parsed.error;
    else {
      finalValue = parsed.value;
      const result = validateReadingEntry({
        value: parsed.value,
        readAt: now,
        dialDigits: task.meter?.dialDigits ?? 12,
        purpose: "final",
        rolloverConfirmed: finalRolloverConfirmed,
        previous: task.previous,
        next: null,
        history: task.history,
        sameDayDuplicate: false,
        inClosedPeriod: false,
      });
      finalNeedsRollover = result.flags.includes("ROLLOVER_CANDIDATE") && !finalRolloverConfirmed;
      if (result.flags.includes("BELOW_LAST")) finalError = "Lower than the last reading and too far to be the dial going round. Check the dial.";
    }
  }

  let initialError: string | undefined;
  let initialValue: number | undefined;
  if (initialText.trim() !== "" && newMeter) {
    const parsed = parseDialValue(initialText, newMeter.dialDigits);
    if (!parsed.ok) initialError = parsed.error;
    else initialValue = parsed.value;
  }

  if (finalValue !== undefined && initialValue !== undefined && !finalError && !initialError && !finalNeedsRollover && !!newMeter && reason.trim() !== "") return { ok: true, finalValue, initialValue, finalNeedsRollover: false };
  return { ok: false, ...(finalValue !== undefined ? { finalValue } : {}), ...(initialValue !== undefined ? { initialValue } : {}), ...(finalError ? { finalError } : {}), ...(initialError ? { initialError } : {}), finalNeedsRollover };
}
