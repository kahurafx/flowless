import { defineApproval } from "../../kernel/approval-store";

export const ADJUSTMENT_APPROVAL_KIND = "billing.adjustment";

/**
 * Approving a credit or debit note (B-11, K-05). `adjustments.request` asks; the note is then
 * issued citing the approved request (`creditNotes.issue`, `debitNotes.issue` with `approvalId`),
 * and a request can be used once. The subject is `<kind>:<accountId>:<uuid>`, the amount the
 * note's absolute total, so an approval for one account or amount cannot cover another. The
 * default policy has one level, holders of `billing:approve`; the organization changes levels,
 * thresholds and SLA in `approvals.billing.adjustment`, and the person asking cannot decide.
 */
export const adjustmentApproval = defineApproval({
  key: ADJUSTMENT_APPROVAL_KIND,
  module: "billing",
  label: "Credit or debit note",
  description: "Approval to credit or debit a customer's account with a note.",
  reasonCodes: [
    { code: "BILLING_ERROR", label: "Billing error" },
    { code: "METER_FAULT", label: "Faulty meter" },
    { code: "LEAK_ALLOWANCE", label: "Leak allowance" },
    { code: "DISPUTE_SETTLED", label: "Dispute settled" },
    { code: "GOODWILL", label: "Goodwill" },
    { code: "OTHER", label: "Other (explain in the note)" },
  ],
  policy: { levels: [{ label: "Accountant", permission: "billing:approve" }], slaHours: 48 },
});
