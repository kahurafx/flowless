import { parseAmount } from "./money-input";

/*
 * Revenue-protection cases (B-19): labels and the back-billing form. Pure; the procedures
 * decide (the look-back limit, the approval and its exact amount).
 */

export const CASE_KINDS = ["illegal_consumption", "terminated_but_consuming", "unbilled_account", "back_billing"] as const;
export type CaseKind = (typeof CASE_KINDS)[number];
export const CASE_DECISIONS = ["no_action", "false_positive", "back_billed", "penalty_applied", "referred"] as const;
export type CaseDecision = (typeof CASE_DECISIONS)[number];

export const CASE_KIND_LABELS: Record<CaseKind, string> = {
  illegal_consumption: "Illegal consumption",
  terminated_but_consuming: "Terminated but consuming",
  unbilled_account: "Unbilled account",
  back_billing: "Back-billing",
};

export const CASE_DECISION_LABELS: Record<CaseDecision, string> = {
  no_action: "No action",
  false_positive: "False positive",
  back_billed: "Back-billed",
  penalty_applied: "Penalty applied (recorded only)",
  referred: "Referred on",
};

export const CASE_EVENT_LABELS: Record<string, string> = { opened: "Opened", evidence: "Evidence added", resolved: "Resolved" };

export interface BackBillRow {
  description: string;
  amount: string;
  serviceFrom: string;
  serviceTo: string;
}
export const emptyBackBillRow: BackBillRow = { description: "", amount: "", serviceFrom: "", serviceTo: "" };

export type BackBillResult = { ok: true; lines: { description: string; amount: bigint; serviceFrom: string; serviceTo: string }[]; total: bigint } | { ok: false; problems: string[] };

/** The lines as the API takes them, with their total (which the approval must match exactly). */
export function backBillLines(rows: readonly BackBillRow[], currency: string): BackBillResult {
  const problems: string[] = [];
  const lines = rows.map((r, i) => {
    const n = i + 1;
    const amount = parseAmount(r.amount, currency);
    if (!r.description.trim()) problems.push(`Line ${n}: say what it is for`);
    if (amount === null) problems.push(`Line ${n}: enter an amount like 1250.00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.serviceFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(r.serviceTo)) problems.push(`Line ${n}: choose the service dates`);
    else if (r.serviceTo < r.serviceFrom) problems.push(`Line ${n}: the service span ends before it starts`);
    return { description: r.description.trim(), amount: amount ?? 0n, serviceFrom: r.serviceFrom, serviceTo: r.serviceTo };
  });
  if (lines.length === 0) problems.push("Add at least one line");
  if (problems.length) return { ok: false, problems };
  return { ok: true, lines, total: lines.reduce((s, l) => s + l.amount, 0n) };
}
