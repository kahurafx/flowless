import type { ModuleKey } from "./modules";

/** Exception queues, the main operational UI (X-02), plus job failures (NF-24). */
export type ExceptionType =
  | "UNBILLED_ACCOUNT"
  | "READING_EXCEPTION"
  | "UNMATCHED_PAYMENT"
  | "UNDELIVERED_MESSAGE"
  | "STALE_ACTIVATION"
  | "STUCK_COMMITMENT"
  | "NO_BASELINE"
  | "JOB_FAILURE";

export type ExceptionStatus = "open" | "in_progress" | "resolved";

export interface ExceptionItem {
  id: string;
  type: ExceptionType;
  /** The module that raised it; "kernel" for job runner failures. */
  source: ModuleKey | "kernel";
  title: string;
  detail: string;
  /** What the exception is about, for linking (account number, payment reference, ...). */
  subject: { kind: "account" | "payment" | "message" | "job"; ref: string };
  /** Every exception has an owner (NF-24); null only while unassigned in a team queue. */
  owner: { id: string; name: string } | null;
  raisedAt: Date;
  status: ExceptionStatus;
}

export type AgeBucket = "fresh" | "ageing" | "overdue";

/** Per-organization thresholds in days (configuration, not code: NF-32). */
export interface AgeThresholds {
  ageingAfterDays: number;
  overdueAfterDays: number;
}

export const DEFAULT_AGE_THRESHOLDS: AgeThresholds = { ageingAfterDays: 2, overdueAfterDays: 7 };

const DAY_MS = 86_400_000;

/** Age is derived from `raisedAt` at read time, never stored. */
export function exceptionAge(
  raisedAt: Date,
  now: Date,
  thresholds: AgeThresholds = DEFAULT_AGE_THRESHOLDS,
): { days: number; bucket: AgeBucket } {
  const days = Math.max(0, Math.floor((now.getTime() - raisedAt.getTime()) / DAY_MS));
  const bucket: AgeBucket =
    days >= thresholds.overdueAfterDays ? "overdue" : days >= thresholds.ageingAfterDays ? "ageing" : "fresh";
  return { days, bucket };
}
