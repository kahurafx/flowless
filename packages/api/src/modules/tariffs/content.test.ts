import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bandsFor, chargeForUnits, fromLineRows, toLineRows, validateTariffContent, type Band, type TariffContent } from "./content";

/** The reference tariff from docs/billing-engine.html: rates in cents per unit, 240.00 above 300 as its placeholder. */
const REFERENCE: Band[] = [
  { from: 0, to: 6, rate: 8250n },
  { from: 6, to: 20, rate: 9600n },
  { from: 20, to: 50, rate: 11000n },
  { from: 50, to: 100, rate: 13100n },
  { from: 100, to: 300, rate: 17250n },
  { from: 300, to: null, rate: 24000n },
];
const increasing = (bands: Band[]): TariffContent => ({ type: "increasing_block", bands });
const shape = { type: "increasing_block", flatBasis: "none" } as const;
const problemsOf = (check: ReturnType<typeof validateTariffContent>) => (check.ok ? [] : check.problems);

// T-01: tariff content is validated per type.
describe("validateTariffContent", () => {
  it("accepts the reference increasing-block tariff", () => {
    expect(validateTariffContent(shape, increasing(REFERENCE))).toMatchObject({ ok: true });
  });

  it("prices the reference scenarios exactly (requirements section 6, S-1 and S-3)", () => {
    const bands = bandsFor(increasing(REFERENCE));
    expect(chargeForUnits(bands, 6) + 15_000n).toBe(64_500n); // S-1: 6 x 82.50 + 150 = 645.00
    expect(chargeForUnits(bands, 20)).toBe(183_900n); // S-3: 1,839.00
    expect(chargeForUnits(bands, 0)).toBe(0n);
    expect(chargeForUnits(bands, 689)).toBe(6n * 8250n + 14n * 9600n + 30n * 11000n + 50n * 13100n + 200n * 17250n + 389n * 24000n);
  });

  it.each([
    ["a first band not at 0", [{ from: 1, to: 6, rate: 1n }, { from: 6, to: null, rate: 2n }], /start at 0/],
    ["a gap", [{ from: 0, to: 6, rate: 1n }, { from: 8, to: null, rate: 2n }], /Gap between bands 1 and 2/],
    ["an overlap", [{ from: 0, to: 6, rate: 1n }, { from: 4, to: null, rate: 2n }], /overlap/],
    ["a band ending before it starts", [{ from: 0, to: 0, rate: 1n }, { from: 0, to: null, rate: 2n }], /must end after it starts/],
    ["an open band that is not last", [{ from: 0, to: null, rate: 1n }, { from: 6, to: null, rate: 2n }], /not the last/],
    ["a closed top band", [{ from: 0, to: 6, rate: 1n }, { from: 6, to: 20, rate: 2n }], /last band \(2\) must be open-ended/],
    ["a falling rate", [{ from: 0, to: 6, rate: 5n }, { from: 6, to: null, rate: 4n }], /must not fall/],
  ] as const)("rejects %s", (_name, bands, pattern) => {
    const check = validateTariffContent(shape, increasing(structuredClone(bands) as unknown as Band[]));
    expect(check.ok).toBe(false);
    expect(problemsOf(check).join(" ")).toMatch(pattern);
  });

  it("rejects negative rates and amounts at the schema", () => {
    expect(validateTariffContent(shape, increasing([{ from: 0, to: null, rate: -1n }])).ok).toBe(false);
    expect(validateTariffContent({ type: "uniform", flatBasis: "none" }, { type: "uniform", rate: -5n }).ok).toBe(false);
    expect(validateTariffContent({ type: "flat_rate", flatBasis: "none" }, { type: "flat_rate", amounts: [{ key: null, amount: -1n }] }).ok).toBe(false);
  });

  it("rejects content for another type, and non-integer or non-bigint rates", () => {
    expect(problemsOf(validateTariffContent(shape, { type: "uniform", rate: 100n })).join()).toMatch(/increasing block tariff/);
    expect(validateTariffContent({ type: "uniform", flatBasis: "none" }, { type: "uniform", rate: 82.5 }).ok).toBe(false);
    expect(validateTariffContent(shape, increasing([{ from: 0.5, to: null, rate: 1n }])).ok).toBe(false);
    expect(validateTariffContent(shape, { type: "increasing_block", bands: [] }).ok).toBe(false);
    expect(validateTariffContent(shape, "nonsense").ok).toBe(false);
  });

  it("requires a decreasing block's rates not to rise", () => {
    const decreasing = { type: "decreasing_block", flatBasis: "none" } as const;
    expect(validateTariffContent(decreasing, { type: "decreasing_block", bands: [{ from: 0, to: 10, rate: 9n }, { from: 10, to: null, rate: 9n }] }).ok).toBe(true);
    expect(validateTariffContent(decreasing, { type: "decreasing_block", bands: [{ from: 0, to: 10, rate: 9n }, { from: 10, to: null, rate: 10n }] }).ok).toBe(false);
    expect(validateTariffContent(decreasing, { type: "decreasing_block", bands: [{ from: 0, to: 10, rate: 9n }, { from: 10, to: null, rate: 3n }] }).ok).toBe(true);
  });

  it("validates a uniform rate", () => {
    expect(validateTariffContent({ type: "uniform", flatBasis: "none" }, { type: "uniform", rate: 12_000n })).toMatchObject({ ok: true });
    expect(bandsFor({ type: "uniform", rate: 12_000n })).toEqual([{ from: 0, to: null, rate: 12_000n }]);
  });

  describe("flat rate", () => {
    const flat = (basis: "property" | "pipe_size" | "taps" | "none", amounts: { key: string | null; amount: bigint }[]) =>
      validateTariffContent({ type: "flat_rate", flatBasis: basis }, { type: "flat_rate", amounts });

    it("takes one keyless amount when there is no basis", () => {
      expect(flat("none", [{ key: null, amount: 50_000n }]).ok).toBe(true);
      expect(flat("none", [{ key: "x", amount: 1n }]).ok).toBe(false);
      expect(flat("none", [{ key: null, amount: 1n }, { key: null, amount: 2n }]).ok).toBe(false);
    });

    it("takes an amount per property type or pipe size, once each", () => {
      expect(flat("property", [{ key: "Residential", amount: 30_000n }, { key: "Commercial", amount: 90_000n }]).ok).toBe(true);
      expect(flat("pipe_size", [{ key: "15mm", amount: 30_000n }, { key: "25mm", amount: 90_000n }]).ok).toBe(true);
      expect(problemsOf(flat("pipe_size", [{ key: "15mm", amount: 1n }, { key: "15MM", amount: 2n }])).join()).toMatch(/appears twice/);
      expect(problemsOf(flat("property", [{ key: null, amount: 1n }])).join()).toMatch(/needs a property/);
    });

    it("takes whole numbers of taps", () => {
      expect(flat("taps", [{ key: "1", amount: 1n }, { key: "2", amount: 2n }]).ok).toBe(true);
      expect(flat("taps", [{ key: "two", amount: 1n }]).ok).toBe(false);
      expect(flat("taps", [{ key: "0", amount: 1n }]).ok).toBe(false);
    });

    it("has no consumption bands", () => {
      expect(bandsFor({ type: "flat_rate", amounts: [{ key: null, amount: 1n }] })).toEqual([]);
    });
  });
});

/** Valid increasing bands: positive widths, rates that never fall, ending open. */
const validBands = fc
  .record({
    widths: fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 0, maxLength: 8 }),
    steps: fc.array(fc.bigInt({ min: 0n, max: 50_000n }), { minLength: 1, maxLength: 9 }),
    first: fc.bigInt({ min: 0n, max: 100_000n }),
  })
  .map(({ widths, steps, first }) => {
    const bands: Band[] = [];
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

// T-01: property tests for band validation.
describe("band validation properties", () => {
  it("accepts every well-formed increasing tariff", () => {
    fc.assert(fc.property(validBands, (bands) => validateTariffContent(shape, increasing(bands)).ok), { numRuns: 300 });
  });

  it("rejects any gap or overlap introduced between two bands", () => {
    fc.assert(
      fc.property(
        validBands.filter((b) => b.length >= 2),
        fc.nat(),
        fc.integer({ min: 1, max: 3 }),
        fc.boolean(),
        (bands, pick, by, up) => {
          const i = 1 + (pick % (bands.length - 1));
          const broken = structuredClone(bands);
          const target = broken[i]!;
          const shifted = up ? target.from + by : target.from - by;
          // Keep the shift meaningful: not below 0 and not a no-op.
          fc.pre(shifted >= 0 && shifted !== target.from);
          target.from = shifted;
          return !validateTariffContent(shape, increasing(broken)).ok;
        },
      ),
      { numRuns: 300 },
    );
  });

  it("rejects any falling rate in an increasing tariff, and any rising rate in a decreasing one", () => {
    fc.assert(
      fc.property(
        validBands.filter((b) => b.length >= 2 && b.some((x, i) => i > 0 && x.rate > b[i - 1]!.rate)),
        (bands) => {
          const reversed = bands.map((b, i) => ({ ...b, rate: bands[bands.length - 1 - i]!.rate }));
          const falls = reversed.some((b, i) => i > 0 && b.rate < reversed[i - 1]!.rate);
          fc.pre(falls);
          const asIncreasing = validateTariffContent(shape, increasing(reversed)).ok;
          const asDecreasing = validateTariffContent({ type: "decreasing_block", flatBasis: "none" }, { type: "decreasing_block", bands: reversed }).ok;
          return !asIncreasing && asDecreasing;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("prices more consumption at least as high, and the bands add up to the total", () => {
    fc.assert(
      fc.property(validBands, fc.integer({ min: 0, max: 5_000 }), fc.integer({ min: 0, max: 500 }), (bands, units, extra) => {
        const a = chargeForUnits(bands, units);
        const b = chargeForUnits(bands, units + extra);
        // Splitting the consumption at any point and pricing the parts band by band gives the whole.
        let sum = 0n;
        for (const band of bands) {
          const upper = band.to ?? Infinity;
          sum += BigInt(Math.max(0, Math.min(units, upper) - band.from)) * band.rate;
        }
        return b >= a && sum === a;
      }),
      { numRuns: 300 },
    );
  });

  it("stores and restores every content unchanged", () => {
    fc.assert(
      fc.property(validBands, (bands) => {
        const content = increasing(bands);
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
