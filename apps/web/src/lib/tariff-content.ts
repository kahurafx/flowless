import { MAX_BANDS, MAX_FLAT_AMOUNTS, MAX_UNITS, bandProblems, flatProblems, type Band, type FlatAmount, type TariffContent, type TariffShape } from "@flowless/shared-types";
import { amountText, parseAmount } from "./money-input";

/*
 * A tariff version's content as a form holds it, and the checks that run while it is
 * typed. The content shape and its rules (`bandProblems`, `flatProblems`, `chargeForUnits`,
 * `validateTariffContent`) are shared through `@flowless/shared-types` with the Tariffs
 * module, so the form and the API cannot disagree; the API still validates every save and
 * its refusal is shown as is.
 *
 * Bands are cumulative thresholds in whole units per billing month: a band covers the units
 * after `from` up to and including `to`. The editor only asks for each band's `to` and rate:
 * a band starts where the one before ended, so bands meet exactly by construction.
 */

/** One band as typed: where it ends ("" for the open top band) and its rate per unit. */
export interface BandDraft {
  to: string;
  rate: string;
}
export interface FlatDraft {
  key: string;
  amount: string;
}
export type ContentDraft =
  | { type: "increasing_block" | "decreasing_block"; bands: BandDraft[] }
  | { type: "uniform"; rate: string }
  | { type: "flat_rate"; amounts: FlatDraft[] };

export type DraftCheck = { ok: true; content: TariffContent } | { ok: false; problems: string[] };

/** A starting draft for a new tariff of this shape. */
export function emptyDraft(shape: TariffShape): ContentDraft {
  switch (shape.type) {
    case "increasing_block":
    case "decreasing_block":
      return { type: shape.type, bands: [{ to: "10", rate: "" }, { to: "", rate: "" }] };
    case "uniform":
      return { type: "uniform", rate: "" };
    case "flat_rate":
      return { type: "flat_rate", amounts: [{ key: "", amount: "" }] };
  }
}

/** The draft that reproduces a stored content (the form for "new version" starts from the one in force). */
export function draftFromContent(content: TariffContent, currency: string): ContentDraft {
  switch (content.type) {
    case "increasing_block":
    case "decreasing_block":
      return { type: content.type, bands: content.bands.map((b) => ({ to: b.to === null ? "" : String(b.to), rate: amountText(b.rate, currency) })) };
    case "uniform":
      return { type: "uniform", rate: amountText(content.rate, currency) };
    case "flat_rate":
      return { type: "flat_rate", amounts: content.amounts.map((a) => ({ key: a.key ?? "", amount: amountText(a.amount, currency) })) };
  }
}

/** Adds a band after the last finite one: the old open band gets an end (10 more units) and a new open band follows. */
export function addBand(bands: readonly BandDraft[]): BandDraft[] {
  const last = bands.at(-1);
  if (!last) return [{ to: "", rate: "" }];
  const previousEnd = bands.length > 1 ? Number(bands.at(-2)!.to) : 0;
  const end = Number.isFinite(previousEnd) ? previousEnd + 10 : 10;
  return [...bands.slice(0, -1), { ...last, to: String(end) }, { to: "", rate: last.rate }];
}

/** Removes a band; whichever band is then last becomes the open one. */
export function removeBand(bands: readonly BandDraft[], index: number): BandDraft[] {
  if (bands.length <= 1) return [...bands];
  const next = bands.filter((_, i) => i !== index);
  const last = next.at(-1)!;
  return [...next.slice(0, -1), { ...last, to: "" }];
}

/**
 * Turns what was typed into content, with every problem a person can fix in the form:
 * amounts that are not amounts, bands that do not end where they should, rates that fall.
 * The same function runs in the browser (live) and in the server action (before the call).
 */
export function parseDraft(draft: ContentDraft, shape: TariffShape, currency: string): DraftCheck {
  if (draft.type !== shape.type) return { ok: false, problems: ["The content does not match the tariff's type"] };
  const problems: string[] = [];
  const money = (text: string, what: string): bigint => {
    const value = parseAmount(text, currency, { allowZero: true });
    if (value === null) {
      problems.push(`${what}: enter an amount like 82.50`);
      return 0n;
    }
    if (value > 10n ** 12n) {
      problems.push(`${what}: that amount is too large`);
      return 0n;
    }
    return value;
  };

  if (draft.type === "uniform") {
    const rate = money(draft.rate, "Rate");
    return problems.length ? { ok: false, problems } : { ok: true, content: { type: "uniform", rate } };
  }

  if (draft.type === "flat_rate") {
    if (draft.amounts.length === 0) return { ok: false, problems: ["Add at least one amount"] };
    if (draft.amounts.length > MAX_FLAT_AMOUNTS) problems.push(`At most ${MAX_FLAT_AMOUNTS} amounts`);
    const amounts: FlatAmount[] = draft.amounts.map((a, i) => ({
      key: shape.flatBasis === "none" ? null : a.key.trim() === "" ? null : a.key.trim(),
      amount: money(a.amount, `Amount ${i + 1}`),
    }));
    problems.push(...flatProblems(amounts, shape.flatBasis));
    return problems.length ? { ok: false, problems } : { ok: true, content: { type: "flat_rate", amounts } };
  }

  if (draft.bands.length === 0) return { ok: false, problems: ["A block tariff needs at least one band"] };
  if (draft.bands.length > MAX_BANDS) problems.push(`At most ${MAX_BANDS} bands`);
  const bands: Band[] = [];
  let from = 0;
  draft.bands.forEach((row, i) => {
    const text = row.to.trim();
    let to: number | null = null;
    if (text !== "") {
      const n = Number(text);
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(n) || n > MAX_UNITS) {
        problems.push(`Band ${i + 1}: the end is a whole number of units`);
        to = from + 1;
      } else to = n;
    }
    bands.push({ from, to, rate: money(row.rate, `Band ${i + 1} rate`) });
    from = to ?? from;
  });
  problems.push(...bandProblems(bands, draft.type === "increasing_block" ? "increasing" : "decreasing"));
  return problems.length ? { ok: false, problems } : { ok: true, content: { type: draft.type, bands } };
}
