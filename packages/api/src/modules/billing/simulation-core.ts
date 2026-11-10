import { periodFromIndex, spanCharge, type Band, type TariffVersion, type TierScaling } from "@flowless/billing-engine";

/*
 * Tariff simulation (T-06), the pure part: price billed consumption spans under a draft tariff
 * and under the tariff in force, with the engine's own `spanCharge` (round once per span, bigint
 * minor units, T-05). No I/O, so it is table-tested. `simulation.ts` loads the facts.
 */

/** One billed consumption line: the months it covered (`from` exclusive, `to` inclusive, period indexes), its units and what was billed. */
export interface SimSpan {
  accountId: string;
  categoryId: string | null;
  /** Document id and line position, to cite the span. */
  lineKey: string;
  from: number;
  to: number;
  units: number;
  billed: bigint;
}

export interface SpanResult {
  lineKey: string;
  from: number;
  to: number;
  units: number;
  billed: bigint;
  current: bigint;
  draft: bigint;
  delta: bigint;
}

export interface AccountResult {
  accountId: string;
  categoryId: string | null;
  spans: SpanResult[];
  skipped: { lineKey: string; reason: "no_tariff_in_force" | "no_category" }[];
  units: number;
  billed: bigint;
  current: bigint;
  draft: bigint;
  delta: bigint;
}

export interface SimulationResult {
  accounts: AccountResult[];
  totals: { accounts: number; affected: number; spans: number; skippedSpans: number; billed: bigint; current: bigint; draft: bigint; delta: bigint };
  /** The accounts whose bill moves most, by absolute change, largest first. */
  topMovers: { accountId: string; current: bigint; draft: bigint; delta: bigint }[];
}

const abs = (n: bigint) => (n < 0n ? -n : n);

/**
 * `current` is the tariff versions in force per category, one entry per month the category was
 * priced in (`from` the month's period), as Billing resolves them through Tariffs; `draftBands`
 * is the draft's rate table. Spans the tariff in force cannot price (no version for a month) are
 * skipped and listed, in both columns, so the totals compare like with like.
 */
export function simulate(input: {
  spans: readonly SimSpan[];
  current: ReadonlyMap<string, readonly TariffVersion[]>;
  draftBands: readonly Band[];
  scaling: TierScaling;
  topN?: number;
}): SimulationResult {
  const byAccount = new Map<string, SimSpan[]>();
  for (const s of input.spans) byAccount.set(s.accountId, [...(byAccount.get(s.accountId) ?? []), s]);

  const accounts: AccountResult[] = [];
  for (const [accountId, spans] of [...byAccount].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const out: AccountResult = { accountId, categoryId: spans[0]?.categoryId ?? null, spans: [], skipped: [], units: 0, billed: 0n, current: 0n, draft: 0n, delta: 0n };
    for (const s of spans) {
      const tariffs = s.categoryId ? input.current.get(s.categoryId) : undefined;
      if (!s.categoryId) {
        out.skipped.push({ lineKey: s.lineKey, reason: "no_category" });
        continue;
      }
      const draftVersion: TariffVersion = { id: "draft", from: periodFromIndex(s.from + 1), standing: 0n, bands: input.draftBands };
      const current = tariffs && spanCharge(s.units, s.from, s.to, tariffs, input.scaling);
      const draft = spanCharge(s.units, s.from, s.to, [draftVersion], input.scaling);
      if (!current || !draft) {
        out.skipped.push({ lineKey: s.lineKey, reason: "no_tariff_in_force" });
        continue;
      }
      const delta = draft.amount - current.amount;
      out.spans.push({ lineKey: s.lineKey, from: s.from, to: s.to, units: s.units, billed: s.billed, current: current.amount, draft: draft.amount, delta });
      out.units += s.units;
      out.billed += s.billed;
      out.current += current.amount;
      out.draft += draft.amount;
      out.delta += delta;
    }
    accounts.push(out);
  }

  const priced = accounts.filter((a) => a.spans.length > 0);
  const sum = (f: (a: AccountResult) => bigint) => priced.reduce((t, a) => t + f(a), 0n);
  return {
    accounts,
    totals: {
      accounts: priced.length,
      affected: priced.filter((a) => a.delta !== 0n).length,
      spans: priced.reduce((t, a) => t + a.spans.length, 0),
      skippedSpans: accounts.reduce((t, a) => t + a.skipped.length, 0),
      billed: sum((a) => a.billed),
      current: sum((a) => a.current),
      draft: sum((a) => a.draft),
      delta: sum((a) => a.delta),
    },
    topMovers: priced
      .filter((a) => a.delta !== 0n)
      .sort((a, b) => (abs(b.delta) > abs(a.delta) ? 1 : abs(b.delta) < abs(a.delta) ? -1 : a.accountId < b.accountId ? -1 : 1))
      .slice(0, input.topN ?? 10)
      .map((a) => ({ accountId: a.accountId, current: a.current, draft: a.draft, delta: a.delta })),
  };
}
