"use server";

import { runAction, type Api } from "@/data/run-action";
import { parseMinorUnits } from "@/lib/account-forms";
import { billingErrorMessage, rebillBill, type RebillForm } from "@/lib/billing-view";

/*
 * Server actions for the statement and document screens (B-11, K-05). Voids and re-bills need
 * `billing:adjust`; the procedures check licence, permission, scope and the rules (a reversal
 * or a voided invoice cannot be voided; a re-bill is for the invoice's own period). A refusal
 * comes back as the dialog's error, with CONFLICT, NOT_FOUND and PRECONDITION_FAILED explained.
 */

/** Runs `change`, rewording a refusal by its code before `runAction` turns it into the dialog's message. */
function billing<T>(change: (api: Api) => Promise<T>) {
  return runAction(async (api) => {
    try {
      return await change(api);
    } catch (error) {
      if (error instanceof Error && "code" in error && typeof error.code === "string") error.message = billingErrorMessage(error.code, error.message);
      throw error;
    }
  });
}

/** Void: a reversal that mirrors the invoice; the original is never edited. `key` is minted once per dialog opening. */
export const voidDocumentAction = async (input: { key: string; documentId: string; reason: string }) =>
  billing((api) => api.billing.documents.void({ idempotencyKey: `void:${input.key}`, documentId: input.documentId, reason: input.reason.trim() }).then(() => null));

/** Re-bill: void and replacement in one step, priced as if the original were void. A held replacement voids nothing. */
export async function rebillAction(input: { key: string; documentId: string; reason: string; form: RebillForm }) {
  const bill = rebillBill(input.form);
  if (!bill.ok) return { error: bill.message } as const;
  return billing((api) =>
    api.billing.documents.rebill({ idempotencyKey: `rebill:${input.key}`, documentId: input.documentId, reason: input.reason.trim(), bill: bill.bill }).then(() => null),
  );
}

/** Asks for approval (K-05) of a credit or debit note; the amount is typed as money and becomes minor units here. */
export async function requestNoteAction(input: { id: string; accountId: string; kind: "credit_note" | "debit_note"; amountText: string; reasonCode: string; note: string; relatedDocumentId?: string }) {
  const amount = parseMinorUnits(input.amountText);
  if (amount === null) return { error: "Enter the amount as money, like 1250.00" } as const;
  return billing((api) =>
    api.billing.adjustments
      .request({
        id: input.id,
        accountId: input.accountId,
        kind: input.kind,
        amount,
        reasonCode: input.reasonCode,
        note: input.note.trim(),
        ...(input.relatedDocumentId ? { relatedDocumentId: input.relatedDocumentId } : {}),
      })
      .then((r) => r.status),
  );
}
