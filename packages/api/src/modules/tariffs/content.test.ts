import type { TariffContent } from "@flowless/shared-types";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fromLineRows, toLineRows } from "./content";

/** Valid increasing bands: positive widths, rates that never fall, ending open. */
const validBands = fc
  .record({
    widths: fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 0, maxLength: 8 }),
    steps: fc.array(fc.bigInt({ min: 0n, max: 50_000n }), { minLength: 1, maxLength: 9 }),
    first: fc.bigInt({ min: 0n, max: 100_000n }),
  })
  .map(({ widths, steps, first }) => {
    const bands: { from: number; to: number | null; rate: bigint }[] = [];
    let from = 0;
    let rate = first;
    widths.forEach((w, i) => {
      bands.push({ from, to: from + w, rate });
      from += w;
      rate += steps[i % steps.length]!;
    });
    bands.push({ from, to: null, rate });
    return bands;
  });

// T-01: a version's content is stored as rows and read back unchanged. The content rules
// themselves are tested with the shared schema in `@flowless/shared-types` (tariff-content).
describe("line rows", () => {
  it("stores and restores every content unchanged", () => {
    fc.assert(
      fc.property(validBands, (bands) => {
        const content: TariffContent = { type: "increasing_block", bands };
        return JSON.stringify(fromLineRows("increasing_block", toLineRows(content)), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) ===
          JSON.stringify(content, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
      }),
      { numRuns: 100 },
    );
    const flat: TariffContent = { type: "flat_rate", amounts: [{ key: "15mm", amount: 5n }, { key: "25mm", amount: 9n }] };
    expect(fromLineRows("flat_rate", toLineRows(flat))).toEqual(flat);
    expect(fromLineRows("uniform", toLineRows({ type: "uniform", rate: 7n }))).toEqual({ type: "uniform", rate: 7n });
  });
});
