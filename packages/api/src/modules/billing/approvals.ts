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

export const CORRECTION_APPROVAL_KIND = "billing.correction";

/**
 * Approving a correction document after the grace window, or a back-billing (B-14, B-19,
 * K-05). Subject `correction:<accountId>:<period>` (the first period corrected), amount the
 * sum of the correction documents' absolute totals, so an approval cannot cover another
 * account, period or a bigger amount. One level, holders of `billing:approve`; the person
 * asking cannot decide.
 */
export const correctionApproval = defineApproval({
  key: CORRECTION_APPROVAL_KIND,
  module: "billing",
  label: "Billing correction",
  description: "Approval to post a correction document for a closed or past-grace period, or a back-billing.",
  reasonCodes: [
    { code: "LATE_READING", label: "Late reading" },
    { code: "READING_CORRECTED", label: "Reading corrected" },
    { code: "BACK_BILLING", label: "Back-billing" },
    { code: "OTHER", label: "Other (explain in the note)" },
  ],
  policy: { levels: [{ label: "Accountant", permission: "billing:approve" }], slaHours: 48 },
});
