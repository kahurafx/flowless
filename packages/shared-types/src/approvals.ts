/** Approvals (K-05): a request waits at one level at a time until it is decided. */
export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_DECISIONS = ["approve", "reject", "cancel"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
