import type { Band as EngineBand, Doc, Line, LineCode, TariffVersion } from "@flowless/billing-engine";
import type { DocumentLineType } from "@flowless/db/schema/billing";
import type { ChargeType } from "@flowless/shared-types";

/*
 * Pure mapping between the billing engine's in-memory model and Billing's rows (T-04, B-14).
 * No I/O: everything here is unit tested without a database.
 */

/** A line ready to insert; `amount` is signed. */
export interface DraftLine {
  lineType: DocumentLineType;
  description: string;
  quantity?: string | null;
  unitRate?: bigint | null;
  amount: bigint;
  serviceFrom?: string | null;
  serviceTo?: string | null;
  tariffVersionId?: string | null;
  chargeItemId?: string | null;
  chargeItemAmountId?: string | null;
  chargeType?: ChargeType | null;
  calculation?: Record<string, unknown> | null;
}

export const monthStart = (period: string) => `${period}-01`;
export const monthEnd = (period: string) => {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};
export const periodOf = (date: string) => date.slice(0, 7);

/** What a category was priced with in one month, as read through Tariffs' published interface. */
export interface PricedMonth {
  period: string;
  tariffVersionId: string;
  bands: readonly { to: number | null; rate: bigint }[];
  /** Standing charge plus meter rent for the month, minor units. */
  standing: bigint;
  standingChargeItemId: string | null;
  standingAmountId: string | null;
  meterRentAmountId: string | null;
}

/**
 * The engine knows one id per tariff version. A bill also cites the standing charge amount
 * version (T-04), which changes on its own dates, so the id the engine carries names all of
 * them and `decodeTariffKey` takes it apart again.
 */
export function tariffKey(m: PricedMonth): string {
  return [m.tariffVersionId, m.standingAmountId ?? "", m.meterRentAmountId ?? "", m.standingChargeItemId ?? ""].join("#");
}
export function decodeTariffKey(key: string) {
  const [tariffVersionId, standingAmountId, meterRentAmountId, standingChargeItemId] = key.split("#");
  return {
    tariffVersionId: tariffVersionId!,
    standingAmountId: standingAmountId || null,
    meterRentAmountId: meterRentAmountId || null,
    standingChargeItemId: standingChargeItemId || null,
  };
}

/** Engine tariff versions from monthly pricing: a new entry whenever anything cited changes. */
export function engineTariffs(months: readonly PricedMonth[]): TariffVersion[] {
  const out: TariffVersion[] = [];
  let last: string | null = null;
  for (const m of [...months].sort((a, b) => a.period.localeCompare(b.period))) {
    const key = tariffKey(m);
    const sig = `${key}|${m.standing}`;
    if (sig === last) continue;
    last = sig;
    const bands: EngineBand[] = m.bands.map((b) => ({ upTo: b.to, rate: b.rate }));
    out.push({ id: key, from: m.period, standing: m.standing, bands });
  }
  return out;
}

const LINE_TYPE: Record<LineCode, DocumentLineType> = {
  USAGE: "consumption",
  USAGE_EST: "consumption",
  CORR: "consumption",
  TRUEUP: "true_up",
  STANDING: "standing",
  TURN_OFF: "fee",
};

/** An engine document's lines as rows, citing the tariff and charge versions used and carrying the working. */
export function linesFromEngineDoc(doc: Doc): DraftLine[] {
  const firstVersion = doc.lines.flatMap((l) => l.tariffVersions)[0];
  return doc.lines.map((l) => {
    const keys = l.tariffVersions.map(decodeTariffKey);
    const first = keys[0] ?? (l.code === "TRUEUP" && firstVersion ? decodeTariffKey(firstVersion) : undefined);
    const standing = l.code === "STANDING";
    return {
      lineType: LINE_TYPE[l.code],
      description: l.description,
      quantity: l.units > 0 ? String(l.units) : null,
      amount: l.amount,
      serviceFrom: monthStart(l.serviceFrom),
      serviceTo: monthEnd(l.serviceTo),
      tariffVersionId: standing ? null : (first?.tariffVersionId ?? null),
      chargeItemId: standing ? (first?.standingChargeItemId ?? null) : null,
      chargeItemAmountId: standing ? (first?.standingAmountId ?? first?.meterRentAmountId ?? null) : null,
      chargeType: standing ? "recurring" : "usage",
      calculation: {
        code: l.code,
        units: l.units,
        tariffVersions: [...l.tariffVersions],
        tariffVersionIds: [...new Set(keys.map((k) => k.tariffVersionId))],
        chargeItemAmountIds: [...new Set(keys.flatMap((k) => [k.standingAmountId, k.meterRentAmountId]).filter((x): x is string => !!x))],
      },
    } satisfies DraftLine;
  });
}

export const sumLines = (lines: readonly { amount: bigint }[]) => lines.reduce((s, l) => s + l.amount, 0n);

export function spanOf(lines: readonly { serviceFrom?: string | null; serviceTo?: string | null }[]) {
  const froms = lines.map((l) => l.serviceFrom).filter((x): x is string => !!x).sort();
  const tos = lines.map((l) => l.serviceTo).filter((x): x is string => !!x).sort();
  return { periodFrom: froms[0] ?? null, periodTo: tos.at(-1) ?? null };
}

/** The sub-ledger account the other side of a receivable entry goes to. */
export function counterAccount(lineType: DocumentLineType): "revenue" | "deposit_liability" | "transfer_clearing" {
  return lineType === "deposit" ? "deposit_liability" : lineType === "transfer" ? "transfer_clearing" : "revenue";
}

/** A stored document line (with the engine code in its working) as an engine line, for true-up and duplicate checks. */
export interface StoredLine {
  amount: bigint;
  serviceFrom: string | null;
  serviceTo: string | null;
  calculation: unknown;
}
export interface StoredDocument {
  id: string;
  kind: string;
  periodTo: string | null;
  total: bigint;
  reversed: boolean;
  lines: readonly StoredLine[];
}

/**
 * Documents the engine produced, rebuilt from stored rows. Documents with a line that has no
 * engine code (a manual credit or debit note) and reversals are left out: they move the
 * balance, which is derived from the ledger, and never feed pricing.
 */
export function engineDocsFrom(stored: readonly StoredDocument[], excluded: ReadonlySet<string> = new Set()): Doc[] {
  const docs: Doc[] = [];
  let id = 0;
  for (const d of stored) {
    if (d.kind === "reversal" || !d.periodTo || d.lines.length === 0) continue;
    const lines: Line[] = [];
    for (const l of d.lines) {
      const c = l.calculation as { code?: LineCode; units?: number; tariffVersions?: string[] } | null;
      if (!c?.code || !l.serviceFrom || !l.serviceTo) break;
      lines.push({ code: c.code, description: "", amount: l.amount, serviceFrom: periodOf(l.serviceFrom), serviceTo: periodOf(l.serviceTo), units: c.units ?? 0, tariffVersions: c.tariffVersions ?? [] });
    }
    if (lines.length !== d.lines.length) continue;
    docs.push({
      id: ++id,
      period: periodOf(d.periodTo),
      type: lines[0]!.code === "CORR" ? "correction" : d.kind === "credit_note" ? "credit_note" : "invoice",
      lines,
      total: d.total,
      final: false,
      voided: d.reversed || excluded.has(d.id),
    });
  }
  return docs;
}
