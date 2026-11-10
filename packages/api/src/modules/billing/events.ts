import { z } from "zod";
import { defineEvent } from "../../kernel/events";

/*
 * What Billing publishes on the kernel outbox (K-09), versioned (NF-32). Payloads are JSON:
 * money is a decimal string of signed minor units, dates are "YYYY-MM-DD". Other modules
 * (Collections, Payments, Communications, Accounts' `markInvoiced`) consume these; none
 * reads Billing's tables.
 */

const minor = z.string().regex(/^-?\d+$/, "signed minor units as digits");

const documentFacts = {
  documentId: z.uuid(),
  number: z.string(),
  accountId: z.uuid(),
  invoiceTypeId: z.uuid(),
  currency: z.string(),
  /** Signed by effect on what the customer owes. */
  total: minor,
  issuedOn: z.iso.date(),
  dueOn: z.iso.date().nullable(),
  periodFrom: z.iso.date().nullable(),
  periodTo: z.iso.date().nullable(),
  issuedByUserId: z.uuid().nullable(),
};

/** An invoice, credit note or debit note was issued and posted to the ledger. */
export const documentIssued = defineEvent(
  "billing.document_issued",
  z.object({
    ...documentFacts,
    kind: z.enum(["invoice", "credit_note", "debit_note"]),
    relatedDocumentId: z.uuid().nullable(),
    /** Set when this invoice is the re-bill of a voided one. */
    replacesDocumentId: z.uuid().nullable(),
  }),
);

/** A document was voided: the reversal is its own document and ledger transaction. */
export const documentReversed = defineEvent(
  "billing.document_reversed",
  z.object({
    ...documentFacts,
    kind: z.literal("reversal"),
    reversesDocumentId: z.uuid(),
    reason: z.string(),
  }),
);

/** A bill was held, not issued (NF-24): the exception queue has the item. */
export const billHeld = defineEvent(
  "billing.bill_held",
  z.object({
    accountId: z.uuid(),
    period: z.string(),
    code: z.string(),
    message: z.string(),
    exceptionId: z.uuid(),
  }),
);
