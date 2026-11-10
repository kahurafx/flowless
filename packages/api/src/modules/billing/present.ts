import type { DocumentLineRow, DocumentRow } from "./post";

/** A document as clients see it. Money is bigint minor units, signed by effect on the balance. */
export function toDocumentDto(d: DocumentRow) {
  return {
    id: d.id,
    kind: d.kind,
    number: d.number,
    invoiceTypeId: d.invoiceTypeId,
    accountId: d.accountId,
    customerId: d.customerId,
    currency: d.currency,
    total: d.total,
    lineCount: d.lineCount,
    issuedOn: d.issuedOn,
    dueOn: d.dueOn,
    periodFrom: d.periodFrom,
    periodTo: d.periodTo,
    relatedDocumentId: d.relatedDocumentId,
    reversesDocumentId: d.reversesDocumentId,
    replacesDocumentId: d.replacesDocumentId,
    note: d.note,
    createdAt: d.createdAt,
    createdByUserId: d.createdByUserId,
  };
}
export type DocumentDto = ReturnType<typeof toDocumentDto>;

export function toLineDto(l: DocumentLineRow) {
  return {
    position: l.position,
    lineType: l.lineType,
    description: l.description,
    quantity: l.quantity,
    unitRate: l.unitRate,
    amount: l.amount,
    serviceFrom: l.serviceFrom,
    serviceTo: l.serviceTo,
    tariffVersionId: l.tariffVersionId,
    chargeItemId: l.chargeItemId,
    chargeItemAmountId: l.chargeItemAmountId,
    chargeType: l.chargeType,
    calculation: l.calculation,
  };
}

/** The audit and event facts of a posted document (money as strings). */
export function documentFacts(d: DocumentRow, issuedByUserId: string | null) {
  return {
    documentId: d.id,
    number: d.number,
    accountId: d.accountId,
    invoiceTypeId: d.invoiceTypeId,
    currency: d.currency,
    total: d.total.toString(),
    issuedOn: d.issuedOn,
    dueOn: d.dueOn,
    periodFrom: d.periodFrom,
    periodTo: d.periodTo,
    issuedByUserId,
  };
}
