import { type FlatBasis, type TariffType } from "@flowless/shared-types";
import { z } from "zod";

/*
 * What a tariff version contains (T-01), and the pure rules that check it. No I/O, no clock.
 *
 * Rates are integer minor units per unit consumed (82.50 a unit is 8250n), which is what
 * docs/billing-engine.html prices with: it rounds once per line, after multiplying, so a
 * rate never needs to be finer than a minor unit. A flat amount is minor units per billing
 * month. Bands are cumulative thresholds in whole units per billing month: a band covers
 * the units after `from` up to and including `to`, so [0, 6] and [6, 20] are the legacy
 * "0-6" and "7-20". Scaling bands by the months in a span is the billing engine's (T-05).
 */

/** Rates and amounts stay far inside a Postgres bigint (and a JavaScript safe integer for display). */
export const MAX_RATE = 10n ** 12n;
export const MAX_BANDS = 20;
export const MAX_FLAT_AMOUNTS = 200;

const rate = z.bigint().min(0n, "Rates cannot be negative").max(MAX_RATE, "Rate is too large");
const units = z.number().int("Bands are whole units").min(0).max(10_000_000);

export const bandSchema = z.object({
  /** Units already used up when this band starts (0 for the first band). */
  from: units,
  /** Units at which this band ends; null on the open top band. */
  to: units.nullable(),
  /** Minor units per unit consumed in the band. */
  rate,
});
export type Band = z.infer<typeof bandSchema>;

export const flatAmountSchema = z.object({
  /** The property type, pipe size or number of taps this amount is for; null when the basis is none. */
  key: z.string().trim().min(1).max(60).nullable(),
  /** Minor units per billing month. */
  amount: rate,
});
export type FlatAmount = z.infer<typeof flatAmountSchema>;

/** The content of one tariff version, by tariff type. */
export const tariffContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("increasing_block"), bands: z.array(bandSchema).min(1).max(MAX_BANDS) }),
  z.object({ type: z.literal("decreasing_block"), bands: z.array(bandSchema).min(1).max(MAX_BANDS) }),
  z.object({ type: z.literal("uniform"), rate }),
  z.object({ type: z.literal("flat_rate"), amounts: z.array(flatAmountSchema).min(1).max(MAX_FLAT_AMOUNTS) }),
]);
export type TariffContent = z.infer<typeof tariffContentSchema>;

export interface TariffShape {
  type: TariffType;
  flatBasis: FlatBasis;
}

export type ContentCheck = { ok: true; content: TariffContent } | { ok: false; problems: string[] };

/** Problems with a block tariff's bands, in the order a person would fix them. Empty when sound. */
export function bandProblems(bands: readonly Band[], direction: "increasing" | "decreasing"): string[] {
  const problems: string[] = [];
  if (bands.length === 0) return ["A block tariff needs at least one band"];
  if (bands[0]!.from !== 0) problems.push("The first band must start at 0 units");
  bands.forEach((band, i) => {
    const n = i + 1;
    const last = i === bands.length - 1;
    if (band.to === null && !last) problems.push(`Band ${n} is open-ended but is not the last band`);
    if (band.to !== null && band.to <= band.from) problems.push(`Band ${n} must end after it starts (${band.from} to ${band.to})`);
    if (band.to !== null && last) problems.push(`The last band (${n}) must be open-ended, so every consumption is priced`);
    const next = bands[i + 1];
    if (next && band.to !== null) {
      if (next.from > band.to) problems.push(`Gap between bands ${n} and ${n + 1}: ${band.to} to ${next.from} units is not priced`);
      if (next.from < band.to) problems.push(`Bands ${n} and ${n + 1} overlap: ${next.from} to ${band.to} units is priced twice`);
      if (direction === "increasing" ? next.rate < band.rate : next.rate > band.rate) {
        problems.push(`Rates must not ${direction === "increasing" ? "fall" : "rise"} from band ${n} to band ${n + 1} in a${direction === "increasing" ? "n increasing" : " decreasing"} block tariff`);
      }
    }
  });
  return problems;
}

/** Problems with a flat-rate tariff's amounts for its basis. */
export function flatProblems(amounts: readonly FlatAmount[], basis: FlatBasis): string[] {
  const problems: string[] = [];
  if (basis === "none") {
    if (amounts.length !== 1 || amounts[0]!.key !== null) problems.push("A flat rate with no basis has exactly one amount and no key");
    return problems;
  }
  const seen = new Set<string>();
  for (const { key } of amounts) {
    if (key === null) {
      problems.push(`Every amount needs a ${basis.replace("_", " ")} to apply to`);
      continue;
    }
    const folded = key.toLowerCase();
    if (seen.has(folded)) problems.push(`"${key}" appears twice`);
    seen.add(folded);
    if (basis === "taps" && !/^[1-9][0-9]{0,2}$/.test(key)) problems.push(`"${key}" is not a number of taps`);
  }
  return problems;
}

/**
 * Checks `input` against the shape a tariff needs (T-01): the right content for its type
 * and basis, bands that start at 0 and meet exactly (no gaps, no overlaps), end open, and
 * whose rates do not fall (increasing) or rise (decreasing); no negative rate or amount.
 */
export function validateTariffContent(shape: TariffShape, input: unknown): ContentCheck {
  const parsed = tariffContentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`) };
  }
  const content = parsed.data;
  if (content.type !== shape.type) return { ok: false, problems: [`This is a ${shape.type.replace("_", " ")} tariff; the content is for a ${content.type.replace("_", " ")} one`] };
  let problems: string[] = [];
  if (content.type === "increasing_block") problems = bandProblems(content.bands, "increasing");
  else if (content.type === "decreasing_block") problems = bandProblems(content.bands, "decreasing");
  else if (content.type === "flat_rate") problems = flatProblems(content.amounts, shape.flatBasis);
  return problems.length ? { ok: false, problems } : { ok: true, content };
}

/**
 * The bands a content prices consumption with: block bands as stored, a uniform rate as one
 * open band from 0, and none for a flat rate (which does not depend on consumption).
 */
export function bandsFor(content: TariffContent): Band[] {
  if (content.type === "uniform") return [{ from: 0, to: null, rate: content.rate }];
  if (content.type === "flat_rate") return [];
  return content.bands.map((b) => ({ ...b }));
}

/**
 * Consumption charge for a whole number of `consumed` units in one billing month, in
 * minor units, exact (bigint). Billing scales bands across months and rounds once per
 * line (T-05, B-18); this is the shared reading of the band shape for tests and previews.
 */
export function chargeForUnits(bands: readonly Band[], consumed: number): bigint {
  let charge = 0n;
  for (const band of bands) {
    const upper = band.to ?? Infinity;
    const inBand = Math.min(consumed, upper) - band.from;
    if (inBand > 0) charge += BigInt(inBand) * band.rate;
    if (consumed <= upper) break;
  }
  return charge;
}

/* ---------- storage rows ---------- */

export interface LineRow {
  position: number;
  fromUnits: number | null;
  toUnits: number | null;
  key: string | null;
  rate: bigint;
}

/** The rows a version's content is stored as (`tariffs.tariff_version_line`). */
export function toLineRows(content: TariffContent): LineRow[] {
  switch (content.type) {
    case "increasing_block":
    case "decreasing_block":
      return content.bands.map((b, position) => ({ position, fromUnits: b.from, toUnits: b.to, key: null, rate: b.rate }));
    case "uniform":
      return [{ position: 0, fromUnits: null, toUnits: null, key: null, rate: content.rate }];
    case "flat_rate":
      return content.amounts.map((a, position) => ({ position, fromUnits: null, toUnits: null, key: a.key, rate: a.amount }));
  }
}

/** The inverse of `toLineRows`. */
export function fromLineRows(type: TariffType, rows: readonly LineRow[]): TariffContent {
  const sorted = [...rows].sort((a, b) => a.position - b.position);
  switch (type) {
    case "increasing_block":
    case "decreasing_block":
      return { type, bands: sorted.map((r) => ({ from: r.fromUnits ?? 0, to: r.toUnits, rate: r.rate })) };
    case "uniform":
      return { type, rate: sorted[0]?.rate ?? 0n };
    case "flat_rate":
      return { type, amounts: sorted.map((r) => ({ key: r.key, amount: r.rate })) };
  }
}
