"use server";

import { orNull } from "@/data/accounts";
import { billingAction } from "@/data/billing-run";
import { getApi } from "@/data/session";
import { CASE_DECISIONS, CASE_KINDS, backBillLines, type BackBillRow } from "@/lib/case-view";
import { parseAmount } from "@/lib/money-input";
import { optionalText } from "@/lib/optional-text";
import { getSession } from "@/data/session";

/*
 * Server actions for revenue cases (B-19). Every command carries the id its dialog minted. The
 * procedures decide the look-back limit, the approval and its exact amount; a refusal is the
 * dialog's message.
 */

export async function openCaseAction(input: { id: string; kind: string; accountNumber: string; title: string; detail: string }) {
  const kind = CASE_KINDS.find((k) => k === input.kind);
  if (!kind) return { error: "Choose what kind of case it is" } as const;
  const { api } = await getApi();
  const account = await orNull(api.accounts.get({ number: input.accountNumber.trim() }));
  if (!account) return { error: `No account ${input.accountNumber.trim()}, or it is outside the areas you can see` } as const;
  return billingAction((a) => a.billing.cases.open({ id: input.id, kind, accountId: account.id, title: input.title.trim(), ...optionalText("detail", input.detail) }).then((r) => ({ id: r.case.id })));
}

export async function addEvidenceAction(input: { id: string; caseId: string; detail: string }) {
  if (!input.detail.trim()) return { error: "Write the evidence" } as const;
  return billingAction((api) => api.billing.cases.addEvidence({ id: input.id, caseId: input.caseId, detail: input.detail.trim() }).then(() => null));
}

export async function requestBackBillingAction(input: { caseId: string; amountText: string; note: string }) {
  const { organization } = await getSession();
  const amount = parseAmount(input.amountText, organization.settings.currency);
  if (amount === null) return { error: "Enter the amount as money, like 1250.00" } as const;
  return billingAction((api) => api.billing.cases.requestBackBilling({ caseId: input.caseId, amount, note: input.note.trim() }).then((r) => r));
}

export async function resolveCaseAction(input: { id: string; caseId: string; decision: string; note: string; invoiceTypeId: string; approvalId: string; lines: BackBillRow[] }) {
  const decision = CASE_DECISIONS.find((d) => d === input.decision);
  if (!decision) return { error: "Choose a decision" } as const;
  if (!input.note.trim()) return { error: "Say why" } as const;
  let backBill: { invoiceTypeId: string; lines: { description: string; amount: bigint; serviceFrom: string; serviceTo: string }[]; approvalId?: string } | undefined;
  if (decision === "back_billed") {
    const { organization } = await getSession();
    const lines = backBillLines(input.lines, organization.settings.currency);
    if (!lines.ok) return { error: lines.problems.join(". ") } as const;
    if (!input.invoiceTypeId) return { error: "Choose the invoice type the debit note posts under" } as const;
    backBill = { invoiceTypeId: input.invoiceTypeId, lines: lines.lines, ...(input.approvalId ? { approvalId: input.approvalId } : {}) };
  }
  return billingAction((api) => api.billing.cases.resolve({ id: input.id, caseId: input.caseId, decision, note: input.note.trim(), ...(backBill ? { backBill } : {}) }).then(() => null));
}
