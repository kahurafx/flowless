import { balance, billedConsumption, lastActual, liveDocs } from "./account";
import { estimateUnits } from "./estimate";
import { assertWhole, sum } from "./money";
import { periodFromIndex, periodIndex, type Period } from "./period";
import { monthCharge, spanCharge, tariffAt, type TariffVersion } from "./tariff";
import type { Account, BillException, Doc, ExceptionCode, Line, LineCode, Reading, Result } from "./types";
import { validateBill } from "./validators";

export interface ReadingInput {
  /** The dial reading. Omit it to request an estimate. */
  dial?: number;
  /** Estimate units; defaults to the policy estimate (B-05). */
  units?: number;
  /** The reading is below the last actual because the dial wrapped (I-5, S-7); the caller has confirmed it. */
  rollover?: boolean;
  /** The previous dial the importing system claims. With no trusted baseline here this is S-8: held NO_BASELINE. */
  claimedPrevious?: number;
}

export interface DisconnectInput {
  /** The mandatory final reading (B-12). */
  dial: number;
  /** Turn-off fee in minor units. */
  fee: bigint;
  /** The disconnection event's key: a repeat posts nothing (S-10). */
  key: string;
  rollover?: boolean;
}

const line = (
  code: LineCode,
  description: string,
  amount: bigint,
  serviceFrom: Period,
  serviceTo: Period,
  units: number,
  tariffVersions: readonly string[],
): Line => ({ code, description, amount, serviceFrom, serviceTo, units, tariffVersions });

const held = (a: Account, code: ExceptionCode, message: string, period: Period): Result => {
  const exception: BillException = { code, message, period };
  return { account: { ...a, exceptions: [...a.exceptions, exception] }, outcome: { kind: "held", exception } };
};

const heldFrom = (a: Account, e: BillException): Result => held(a, e.code, e.message, e.period);

interface IssueOptions extends ReadingInput {
  final?: boolean;
  fee?: bigint;
}

function issue(a: Account, tariffs: readonly TariffVersion[], period: Period, o: IssueOptions): Result {
  const p = periodIndex(period);
  const estimate = o.dial == null;
  if (o.dial != null) assertWhole(o.dial, "dial");
  if (o.units != null) assertWhole(o.units, "units");
  if (a.status !== "ACTIVE" && !o.final) return held(a, "STATUS_BLOCKED", `Account is ${a.status}; no bill issued`, period);
  if (liveDocs(a).some((d) => d.period === period && d.type !== "correction")) {
    return held(a, "DUPLICATE_PERIOD", "This period is already billed", period);
  }
  const t = tariffAt(tariffs, p);
  if (!t) return held(a, "MISSING_TARIFF", "No tariff in force for the period; held", period);

  let seq = a.seq;
  const last = lastActual(a, p);
  if (!last) {
    if (estimate) return held(a, "NO_BASELINE", "No trusted actual reading; held for a verified reading", period);
    if (o.claimedPrevious != null) {
      return held(a, "NO_BASELINE", "The import claims an earlier reading but none is on file; held", period);
    }
    const reading: Reading = { id: ++seq, period, kind: "actual", dial: o.dial as number, voided: false, flags: [] };
    return { account: { ...a, seq, readings: [...a.readings, reading] }, outcome: { kind: "baseline" } };
  }

  const lp = periodIndex(last.period);
  const n = p - lp;
  const lines: Line[] = [];
  let u: number;
  if (estimate) {
    const eu = o.units ?? estimateUnits(a, p);
    if (eu == null) return held(a, "NO_HISTORY", "No usage history to estimate from; held", period);
    u = eu;
    lines.push(line("USAGE_EST", `Estimated usage, ${u} units`, monthCharge(u, t), period, period, u, [t.id]));
  } else {
    u = (o.dial as number) - (last.dial as number);
    if (u < 0) {
      if (!o.rollover) {
        return held(a, "NEGATIVE_OR_ROLLOVER", `Reading is below the last actual (${last.dial}); confirm rollover or fix the reading`, period);
      }
      u += 10 ** a.digits;
    }
    const prev = billedConsumption(a, lp, p - 1);
    const from = periodFromIndex(lp + 1);
    if (a.policy.scaling === "none") {
      const est = prev.filter((l) => l.code === "USAGE_EST").reduce((s, l) => s + l.units, 0);
      const r = Math.max(0, u - est);
      lines.push(line("USAGE", `Usage, ${r} units (legacy: remainder as one month)`, monthCharge(r, t), from, period, r, [t.id]));
    } else {
      const c = spanCharge(u, lp, p, tariffs, "by_period");
      if (!c) return held(a, "MISSING_TARIFF", "No tariff in force for part of the span; held", period);
      lines.push(line("USAGE", `Usage, ${u} units over ${n} month(s)`, c.amount, from, period, u, c.versions));
      const billedBefore = sum(prev, (l) => l.amount);
      if (billedBefore !== 0n) {
        lines.push(line("TRUEUP", "Less estimates already billed", -billedBefore, from, periodFromIndex(p - 1), 0, []));
      }
    }
  }
  // Standing charges: this month's, plus any earlier month of the span that was never billed.
  for (let i = lp + 1; i <= p; i++) {
    if (i !== p && liveDocs(a).some((d) => periodIndex(d.period) === i)) continue;
    const ti = tariffAt(tariffs, i);
    if (!ti) return held(a, "MISSING_TARIFF", "No tariff in force for part of the span; held", period);
    lines.push(line("STANDING", "Standing charge and meter rent", ti.standing, periodFromIndex(i), periodFromIndex(i), 0, [ti.id]));
  }
  if (o.final && o.fee) lines.push(line("TURN_OFF", "Turn-off fee", o.fee, period, period, 0, []));

  const total = sum(lines, (l) => l.amount);
  const failure = validateBill({ period, lines, total, estimate, units: u, months: n, tariff: t, ceiling: a.policy.ceiling });
  if (failure) return heldFrom(a, failure);

  const readingId = ++seq;
  const reading: Reading = estimate
    ? { id: readingId, period, kind: "estimate", units: u, voided: false, flags: [] }
    : { id: readingId, period, kind: "actual", dial: o.dial as number, units: u, months: n, voided: false, flags: [] };
  // The credit-note rule: a negative total is a credit note, never a negative invoice.
  const doc: Doc = { id: ++seq, period, type: total < 0n ? "credit_note" : "invoice", lines, total, readingId, final: !!o.final, voided: false };
  return { account: { ...a, seq, readings: [...a.readings, reading], docs: [...a.docs, doc] }, outcome: { kind: "billed", doc } };
}

/** Bill a reading or, with no dial, an estimate: actual with true-up, estimate, baseline or held (B-08, B-10). */
export function billReading(a: Account, tariffs: readonly TariffVersion[], period: Period, input: ReadingInput = {}): Result {
  return issue(a, tariffs, period, input);
}

/**
 * Void a document: it is flagged and a reversal posts, so the balance and the baseline return to
 * what they were before it (I-3). Nothing is deleted (NF-22).
 */
export function voidDocument(a: Account, docId: number): Result {
  const d = a.docs.find((x) => x.id === docId && !x.voided && x.type !== "reversal" && x.type !== "payment");
  if (!d) return { account: a, outcome: { kind: "not_found" } };
  const reversal: Doc = {
    id: a.seq + 1,
    period: d.period,
    type: "reversal",
    ref: d.id,
    lines: d.lines.map((l) => ({ ...l, amount: -l.amount })),
    total: -d.total,
    final: false,
    voided: false,
  };
  return {
    account: {
      ...a,
      seq: a.seq + 1,
      docs: [...a.docs.map((x) => (x.id === d.id ? { ...x, voided: true } : x)), reversal],
      readings: a.readings.map((r) => (r.id === d.readingId ? { ...r, voided: true } : r)),
    },
    outcome: { kind: "billed", doc: reversal },
  };
}

/**
 * Re-price the actual reading of `period` after the baseline or an earlier reading changed (S-6). Posts one
 * typed CORR line for the difference against what is billed in the span; a second call finds none (B-14).
 */
export function correctPeriod(a: Account, tariffs: readonly TariffVersion[], period: Period): Result {
  const p = periodIndex(period);
  const r = a.readings.find((x) => x.period === period && x.kind === "actual" && !x.voided && x.units != null);
  if (!r) return held(a, "NO_READING", "No actual reading in that period", period);
  const last = lastActual(a, p);
  if (!last) return held(a, "NO_BASELINE", "No earlier actual reading", period);
  const lp = periodIndex(last.period);
  const u = (r.dial as number) - (last.dial as number);
  if (u < 0) return held(a, "NEGATIVE_OR_ROLLOVER", "Reading is below the new baseline", period);
  const c = spanCharge(u, lp, p, tariffs, a.policy.scaling);
  if (!c) return held(a, "MISSING_TARIFF", "No tariff in force for part of the span; held", period);
  const diff = c.amount - sum(billedConsumption(a, lp, p), (l) => l.amount);
  const readings = a.readings.map((x) =>
    x.id === r.id ? { ...x, units: u, months: p - lp, flags: x.flags.includes("corrected") ? x.flags : [...x.flags, "corrected" as const] } : x,
  );
  if (diff === 0n) return { account: { ...a, readings }, outcome: { kind: "none" } };
  const doc: Doc = {
    id: a.seq + 1,
    period,
    type: "correction",
    lines: [line("CORR", "Reading correction", diff, periodFromIndex(lp + 1), period, 0, c.versions)],
    total: diff,
    final: false,
    voided: false,
  };
  return { account: { ...a, seq: a.seq + 1, readings, docs: [...a.docs, doc] }, outcome: { kind: "billed", doc } };
}

/**
 * Final bill on disconnection (B-12, S-9, S-10): the final units, the month's standing charge and the
 * turn-off fee, once per event key. The account becomes DISCONNECTED; later bills are blocked (I-8).
 */
export function finalBill(a: Account, tariffs: readonly TariffVersion[], period: Period, input: DisconnectInput): Result {
  if (a.keys.includes(input.key)) return { account: a, outcome: { kind: "duplicate" } };
  const r = issue(a, tariffs, period, { dial: input.dial, rollover: input.rollover, final: true, fee: input.fee });
  if (r.outcome.kind === "held") return r;
  return { account: { ...r.account, status: "DISCONNECTED", keys: [...r.account.keys, input.key] }, outcome: r.outcome };
}

/** A payment reduces the balance as its own document. */
export function postPayment(a: Account, amount: bigint): Account {
  if (amount <= 0n) throw new RangeError("A payment must be positive");
  const doc: Doc = { id: a.seq + 1, period: "", type: "payment", lines: [], total: -amount, final: false, voided: false };
  return { ...a, seq: a.seq + 1, docs: [...a.docs, doc] };
}

export { balance };
