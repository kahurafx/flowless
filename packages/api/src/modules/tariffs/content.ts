import type { TariffContent, TariffType } from "@flowless/shared-types";

/*
 * How a tariff version's content is stored (`tariffs.tariff_version_line`): one row per band,
 * flat amount or uniform rate. The content shape and its rules are shared with the web in
 * `@flowless/shared-types` (tariff-content), so the form and the API cannot drift apart.
 */

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
