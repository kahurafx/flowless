import type { ExceptionItem } from "@flowless/shared-types";
import { people, TENANT_A, TENANT_B } from "./tenants";

type MockException = Omit<ExceptionItem, "raisedAt"> & { organizationId: string; raisedDaysAgo: number };

const { wanjiru, baraka, achieng, otieno } = people;

export const exceptions: readonly MockException[] = [
  { organizationId: TENANT_A, id: "ex-01", type: "READING_EXCEPTION", source: "metering", title: "Reading below last actual", detail: "Read 0412 on 6 Nov; last actual 0436. Rollover not declared (M-05, I-5).", subject: { kind: "account", ref: "1031-6" }, owner: baraka, raisedDaysAgo: 1, status: "open" },
  { organizationId: TENANT_A, id: "ex-02", type: "NO_BASELINE", source: "migration", title: "No trusted baseline reading", detail: "Imported previous 6, current 707. Held until a verified reading (Q-08, S-8).", subject: { kind: "account", ref: "1009-2" }, owner: achieng, raisedDaysAgo: 9, status: "in_progress" },
  { organizationId: TENANT_A, id: "ex-03", type: "UNMATCHED_PAYMENT", source: "payments", title: "M-Pesa payment with unknown account", detail: "KES 2,300.00 to account 10O8 (letter O). Candidates by phone: 1008-4 (P-03, P-06).", subject: { kind: "payment", ref: "SKZ7T1AB9Q" }, owner: wanjiru, raisedDaysAgo: 0, status: "open" },
  { organizationId: TENANT_A, id: "ex-04", type: "UNDELIVERED_MESSAGE", source: "communications", title: "No phone for bill delivery", detail: "October bill not sent: account has no phone. In fallback queue for print (N-04).", subject: { kind: "message", ref: "1009-2" }, owner: null, raisedDaysAgo: 4, status: "open" },
  { organizationId: TENANT_A, id: "ex-05", type: "STALE_ACTIVATION", source: "accounts", title: "Stuck in PENDING_PAYMENT", detail: "Deposit partly paid 4 days ago; activation threshold not met (C-06).", subject: { kind: "account", ref: "1011-5" }, owner: wanjiru, raisedDaysAgo: 4, status: "open" },
  { organizationId: TENANT_A, id: "ex-06", type: "UNBILLED_ACCOUNT", source: "billing", title: "Eligible account not billed", detail: "In the November snapshot with no bill, estimate, exception or exclusion (B-04).", subject: { kind: "account", ref: "1040-9" }, owner: baraka, raisedDaysAgo: 2, status: "open" },
  { organizationId: TENANT_A, id: "ex-07", type: "JOB_FAILURE", source: "kernel", title: "SMS delivery-receipt poll failed", detail: "Provider timed out after 3 retries with backoff. Dead-lettered (NF-23, NF-24).", subject: { kind: "job", ref: "job-poll-dlr-20261106" }, owner: achieng, raisedDaysAgo: 1, status: "open" },
  { organizationId: TENANT_A, id: "ex-08", type: "STUCK_COMMITMENT", source: "collections", title: "Missed installment", detail: "Installment 2 of 4 due 28 Oct not paid; commitment moves to defaulted (D-02).", subject: { kind: "account", ref: "1010-8" }, owner: baraka, raisedDaysAgo: 10, status: "open" },
  { organizationId: TENANT_A, id: "ex-09", type: "READING_EXCEPTION", source: "metering", title: "Rollover candidate", detail: "Dial 9990 → 0015 on a 4-digit meter: 25 units pending technician confirmation (M-07, S-7).", subject: { kind: "account", ref: "1008B-1" }, owner: baraka, raisedDaysAgo: 3, status: "in_progress" },
  { organizationId: TENANT_B, id: "ex-b1", type: "UNMATCHED_PAYMENT", source: "payments", title: "Bank deposit without reference", detail: "KES 5,000.00 deposited at the branch with no account number (P-06).", subject: { kind: "payment", ref: "KCB-2026-77310" }, owner: otieno, raisedDaysAgo: 5, status: "open" },
];
