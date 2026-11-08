import type { ModuleKey } from "./modules";

/**
 * Exception queues, the main operational UI (X-02), plus background failures (NF-24).
 * A module adds its types here when it ships; the kernel raises the failure types.
 */
export const EXCEPTION_TYPES = [
  "UNBILLED_ACCOUNT",
  "READING_EXCEPTION",
  "UNMATCHED_PAYMENT",
  "UNDELIVERED_MESSAGE",
  "STALE_ACTIVATION",
  "STUCK_COMMITMENT",
  "NO_BASELINE",
  "JOB_FAILURE",
  "EVENT_FAILURE",
  "APPROVAL_OVERDUE",
  "WORK_ORDER_OVERDUE",
] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];

export const EXCEPTION_STATUSES = ["open", "in_progress", "resolved"] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

export const EXCEPTION_SUBJECT_KINDS = ["account", "payment", "message", "job", "event", "approval", "work_order"] as const;
export type ExceptionSubjectKind = (typeof EXCEPTION_SUBJECT_KINDS)[number];

export interface ExceptionItem {
  id: string;
  type: ExceptionType;
  /** The module that raised it; "kernel" for job runner failures. */
  source: ModuleKey | "kernel";
  title: string;
  detail: string;
  /** What the exception is about, for linking (account number, payment reference, ...). */
  subject: { kind: ExceptionSubjectKind; ref: string };
  /** Every exception has an owner (NF-24); null only while unassigned in a team queue. */
  owner: { id: string; name: string } | null;
  raisedAt: Date;
  status: ExceptionStatus;
  /** How many times the same problem was raised while this stayed open. */
  occurrences: number;
  /** Background failures can be retried from the queue. */
  retryable: boolean;
  /** Fixture data shown until the raising module exists (UI track). */
  demo?: boolean;
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
