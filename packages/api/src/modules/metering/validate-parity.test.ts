import { validateReadingEntry } from "@flowless/shared-types";
import { describe, expect, it } from "vitest";
import { meteringValidationSchema } from "./settings";
import { validateReading, type ValidationInput } from "./validate";

/** The field app validates with shared-types' port; it must say what the server says (M-05, M-07). */
describe("validateReadingEntry equals validateReading", () => {
  it("agrees on a grid of readings, neighbours, purposes and configs", () => {
    const day = 86_400_000;
    const t0 = Date.UTC(2026, 0, 1, 8);
    const configs = [meteringValidationSchema.parse({}), meteringValidationSchema.parse({ lowFactor: 0.5, maxUnitsPerDay: 40, rolloverMaxFraction: 0.3 })];
    let seed = 7;
    const next = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    let checked = 0;
    for (let i = 0; i < 400; i++) {
      const previous = i % 7 === 0 ? null : { value: next(99_999), readAt: new Date(t0 + next(20) * day) };
      const history = [1, 2, 3, 4].map((k) => ({ value: next(99_999), readAt: new Date(t0 - k * 30 * day + next(5) * day) }));
      const input: ValidationInput = {
        value: next(100_000),
        readAt: new Date(t0 + (20 + next(60)) * day + next(24) * 3_600_000),
        dialDigits: 5,
        purpose: (["routine", "routine", "initial", "final"] as const)[next(4)]!,
        rolloverConfirmed: next(2) === 1,
        previous,
        next: next(5) === 0 ? { value: next(100_000), readAt: new Date(t0 + 90 * day) } : null,
        history,
        sameDayDuplicate: next(4) === 0,
        inClosedPeriod: next(4) === 0,
      };
      for (const config of configs) {
        expect(validateReadingEntry(input, config)).toEqual(validateReading(input, config));
        checked++;
      }
    }
    expect(checked).toBe(800);
  });
});
