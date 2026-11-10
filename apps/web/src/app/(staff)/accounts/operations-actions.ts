"use server";

import { billingAction } from "@/data/billing-run";
import { parseDial } from "@/lib/metering-view";
import { isPeriod } from "@/lib/cycle-view";
import { optionalText } from "@/lib/optional-text";

/*
 * Server actions for disconnection, reconnection and corrections (B-12, B-13, B-14). Each
 * command carries the id its dialog minted. The procedures decide everything: the final dial
 * of a metered account, the refusal of a held final bill, the grace window, evidence and
 * approval. A refusal comes back as the dialog's message.
 */

export async function disconnectAction(input: { id: string; accountId: string; dial: string; digits: number; rollover: boolean; reason: string; note: string; feeItemId: string }) {
  const dial = parseDial(input.dial, input.digits);
  if (!dial.ok) return { error: dial.problem } as const;
  return billingAction((api) =>
    api.billing.disconnections
      .disconnect({
        id: input.id,
        accountId: input.accountId,
        dial: dial.value,
        reason: input.reason.trim(),
        ...(input.rollover ? { rollover: true } : {}),
        ...(input.feeItemId ? { turnOffFeeChargeItemId: input.feeItemId } : {}),
        ...optionalText("note", input.note),
      })
      .then((r) => r),
  );
}

export async function reconnectAction(input: { id: string; accountId: string; dial: string; digits: number; reason: string; note: string }) {
  const dial = parseDial(input.dial, input.digits);
  if (!dial.ok) return { error: dial.problem } as const;
  return billingAction((api) => api.billing.disconnections.reconnect({ id: input.id, accountId: input.accountId, dial: dial.value, reason: input.reason.trim(), ...optionalText("note", input.note) }).then((r) => r));
}

const evidenceOf = (note: string) => (note.trim() ? { evidence: { note: note.trim() } } : {});

/** What posting would do: the documents, the route (clerk or approval), the grace window and whether evidence is missing. Nothing is written. */
export async function previewCorrectionAction(input: { accountId: string; period: string; evidenceNote: string }) {
  if (!isPeriod(input.period)) return { error: "Enter the period as year and month, like 2026-05" } as const;
  return billingAction((api) => api.billing.corrections.preview({ accountId: input.accountId, period: input.period, ...evidenceOf(input.evidenceNote) }), { refresh: false });
}

export async function requestCorrectionAction(input: { accountId: string; period: string; reasonCode: string; note: string; evidenceNote: string }) {
  return billingAction((api) =>
    api.billing.corrections.request({ accountId: input.accountId, period: input.period, reasonCode: input.reasonCode, note: input.note.trim(), ...evidenceOf(input.evidenceNote) }).then((r) => r),
  );
}

export async function postCorrectionAction(input: { id: string; accountId: string; period: string; evidenceNote: string; approvalId: string; note: string }) {
  return billingAction((api) =>
    api.billing.corrections
      .post({ id: input.id, accountId: input.accountId, period: input.period, ...(input.approvalId ? { approvalId: input.approvalId } : {}), ...evidenceOf(input.evidenceNote), ...optionalText("note", input.note) })
      .then((r) => r),
  );
}
