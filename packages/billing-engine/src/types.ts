import type { Minor } from "./money";
import type { Period } from "./period";
import type { TierScaling } from "./tariff";

export type LineCode = "USAGE" | "USAGE_EST" | "TRUEUP" | "CORR" | "STANDING" | "TURN_OFF";

/** Lines whose sum is "unit charges billed" for the core formula (section 6). */
export const CONSUMPTION_CODES: readonly LineCode[] = ["USAGE", "USAGE_EST", "TRUEUP", "CORR"];

/** A typed invoice line with the service span it covers and the tariff versions used (T-04, B-14). */
export interface Line {
  code: LineCode;
  description: string;
  amount: Minor;
  serviceFrom: Period;
  serviceTo: Period;
  /** Units priced by the line; 0 for lines that are not volumetric. */
  units: number;
  tariffVersions: readonly string[];
}

export type DocType = "invoice" | "credit_note" | "correction" | "reversal" | "payment";

/** An append-only ledger document. `voided` is the only flag that changes, and only together with a reversal. */
export interface Doc {
  id: number;
  period: Period;
  type: DocType;
  lines: readonly Line[];
  total: Minor;
  /** The reading this document was issued for. */
  readingId?: number;
  /** For a reversal, the document it reverses. */
  ref?: number;
  final: boolean;
  voided: boolean;
}

/** B-06: flagged readings never feed an estimate. */
export type ReadingFlag = "baseline_gap" | "corrected" | "disputed";

export interface Reading {
  id: number;
  period: Period;
  kind: "actual" | "estimate";
  dial?: number;
  /** Units for the span ending at this reading (actual after a baseline) or the estimate. */
  units?: number;
  /** Months in the span ending at this reading. */
  months?: number;
  /**
   * Meter change (M-07, I-5): units = dial - previous dial + carry, where carry = old final - new initial
   * (plus the dial wrap when the old span rolled over). Absent for an ordinary reading.
   */
  carry?: number;
  voided: boolean;
  flags: readonly ReadingFlag[];
}

/** B-05 estimation methods. */
export type EstimateMethod = "median" | "trimmed_mean" | "same_month_last_year" | "last_actual" | "fixed_minimum" | "none";
/** Under method `none` the organization chooses what an unread account gets (B-05); the account is always flagged. */
export type NoneAction = "hold" | "standing_only" | "skip";

export interface Policy {
  scaling: TierScaling;
  /** Estimate: the last N usable actual spans, as units per month. */
  avgN: number;
  /** The baseline: estimate units when there is no usable history; null means hold (NO_HISTORY). */
  fallback: number | null;
  /** Estimation method (B-05); default median. */
  method?: EstimateMethod;
  /** Fraction dropped from each end by trimmed_mean; default 0.2. */
  trim?: number;
  /** Units a month for fixed_minimum. */
  fixedMinimum?: number | null;
  /** What method `none` does with an unread account; default hold. */
  noneAction?: NoneAction;
  /** B-08: flag a bill whose units a month exceed this multiple of the history median; default 3, 0 turns it off. */
  outlierFactor?: number;
  /** Absolute ceiling in units per month; above it the bill is held (B-08). */
  ceiling: number;
}

export type ExceptionCode =
  | "STATUS_BLOCKED"
  | "DUPLICATE_PERIOD"
  | "NO_BASELINE"
  | "NO_HISTORY"
  | "NEGATIVE_OR_ROLLOVER"
  | "ZERO_CHARGE"
  | "OUTLIER_HOLD"
  | "NO_STANDING"
  | "MISSING_TARIFF"
  | "LINES_NOT_SUMMING"
  | "NO_READING"
  | "NO_ESTIMATE"
  | "OUTCOME_HOLD"
  | "NOT_DISCONNECTED"
  | "METER_CHANGE_INVALID"
  | "ZERO_CONSUMPTION"
  | "STANDING_ONLY"
  | "OUTLIER_HISTORY"
  | "SUSPECTED_ILLEGAL_CONSUMPTION";

/** A held bill: never silent (NF-24). The caller turns it into a visible exception with owner and age. */
export interface BillException {
  code: ExceptionCode;
  message: string;
  period: Period;
}

/** The engine's whole state for one account. Plain data, replaced (never edited) by every operation. */
export interface Account {
  status: string;
  /** Dial digits, for rollover. */
  digits: number;
  policy: Policy;
  readings: readonly Reading[];
  docs: readonly Doc[];
  exceptions: readonly BillException[];
  /** Idempotency keys of disconnections already applied. */
  keys: readonly string[];
  /** Last id handed out for a reading or document. */
  seq: number;
}

export type Outcome =
  /** `flags` are B-08/B-10 findings that do not block the bill: the caller shows them as flags or exceptions. */
  | { kind: "billed"; doc: Doc; flags?: readonly BillException[] }
  /** Nothing billed for this period on purpose (M-06 skip, B-05 none/skip); the account is flagged. */
  | { kind: "skipped"; exception: BillException }
  /** B-12: reconnected from the final reading; the dial had moved, so a suspected illegal consumption case is raised. */
  | { kind: "suspected_illegal_consumption"; exception: BillException; movedBy: number }
  | { kind: "reconnected" }
  | { kind: "baseline" }
  | { kind: "held"; exception: BillException }
  | { kind: "duplicate" }
  | { kind: "none" }
  | { kind: "not_found" };

export interface Result {
  account: Account;
  outcome: Outcome;
}
