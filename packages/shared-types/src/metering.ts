/*
 * Metering vocabulary shared by the API, web and the field app (M-01 to M-07). Pure: no I/O.
 */

/** M-01: a meter's lifecycle, in the order a meter normally moves through it. */
export const METER_STATUSES = ["procured", "in_stock", "issued", "installed", "tested", "replaced", "disposed"] as const;
export type MeterStatus = (typeof METER_STATUSES)[number];

/** Where a meter may go from each status. `disposed` is final. */
export const METER_TRANSITIONS: Readonly<Record<MeterStatus, readonly MeterStatus[]>> = {
  procured: ["in_stock", "disposed"],
  in_stock: ["issued", "installed", "tested", "disposed"],
  issued: ["installed", "in_stock", "tested", "disposed"],
  tested: ["in_stock", "issued", "installed", "disposed"],
  installed: ["tested", "replaced", "in_stock", "disposed"],
  replaced: ["in_stock", "disposed"],
  disposed: [],
};

export function canMoveMeter(from: MeterStatus, to: MeterStatus): boolean {
  return METER_TRANSITIONS[from].includes(to);
}

/** Dial digit counts a register accepts. */
export const MIN_DIAL_DIGITS = 1;
export const MAX_DIAL_DIGITS = 12;

/** M-03: where a reading came from. `estimate` is a separate type and never a baseline. */
export const READING_SOURCES = ["technician", "office", "customer", "import", "estimate"] as const;
export type ReadingSource = (typeof READING_SOURCES)[number];

/** M-02: a reading's status; the newest status row decides. */
export const READING_STATUSES = ["valid", "voided", "superseded"] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

/** M-04: the reader's own judgement of the reading. */
export const READING_QUALITIES = ["good", "doubtful", "poor"] as const;
export type ReadingQuality = (typeof READING_QUALITIES)[number];

/** `initial` is a new meter's first reading and `final` an old meter's last (M-07); neither is validated against a previous. */
export const READING_PURPOSES = ["routine", "initial", "final"] as const;
export type ReadingPurpose = (typeof READING_PURPOSES)[number];

/**
 * M-05 validation flags. A blocking flag keeps the reading out of automatic billing until
 * someone approves it; an advisory flag is recorded and billing goes on.
 */
export const READING_FLAGS = {
  BELOW_LAST: { blocking: true, label: "Below the last actual reading" },
  ROLLOVER_CANDIDATE: { blocking: true, label: "Looks like the dial went round; needs confirming" },
  ZERO: { blocking: true, label: "Reading is zero" },
  ABOVE_RANGE: { blocking: true, label: "Consumption is above the expected range" },
  BELOW_RANGE: { blocking: true, label: "Consumption is below the expected range" },
  SAME_DAY_DUPLICATE: { blocking: true, label: "Another reading exists for the same day" },
  OUT_OF_SEQUENCE: { blocking: true, label: "Higher than a later reading" },
  ZERO_CONSUMPTION: { blocking: false, label: "No consumption since the previous reading" },
  CLOSED_PERIOD: { blocking: false, label: "Read inside a closed billing period" },
} as const;
export type ReadingFlag = keyof typeof READING_FLAGS;
export const READING_FLAG_CODES = Object.keys(READING_FLAGS) as ReadingFlag[];
export const isBlockingFlag = (flag: string): boolean => (READING_FLAGS as Record<string, { blocking: boolean }>)[flag]?.blocking ?? true;

/** Units consumed between two dial values, counting one wrap of a dial with `digits` digits when `rollover` is confirmed. */
export function consumptionBetween(previous: number, value: number, digits: number, rollover: boolean): number {
  return rollover ? 10 ** digits - previous + value : value - previous;
}

/** M-12: what a meter measures. A customer meter bills an account; bulk (DMA inlet) and master (scheme) meters measure supply for water balance. */
export const METER_KINDS = ["customer", "bulk", "master"] as const;
export type MeterKind = (typeof METER_KINDS)[number];

/*
 * M-06 reading outcomes and dispositions. The lists are the billing engine's (`disposition.ts`,
 * which has no dependencies and so cannot import from here); a test in packages/api keeps the
 * two identical. The database checks and the API validate against these.
 */
export const READING_OUTCOMES = [
  "read_ok",
  "meter_inaccessible",
  "meter_faulty",
  "no_meter_found",
  "locked_premises",
  "dog_or_hazard",
  "customer_refused",
  "illegal_connection_suspected",
] as const;
export type ReadingOutcome = (typeof READING_OUTCOMES)[number];

export const DISPOSITIONS = ["bill_actual", "estimate", "hold", "standing_only", "skip"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** Condition tags on one attempt, at most. */
export const ATTEMPT_MAX_TAGS = 12;

/** M-08: why a service point is, or is not, eligible on a route's round. */
export const ELIGIBILITY_REASONS = ["eligible", "consumption_not_billed", "no_meter", "service_point_not_live"] as const;
export type EligibilityReason = (typeof ELIGIBILITY_REASONS)[number];
