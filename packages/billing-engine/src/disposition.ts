/** M-06: what the technician found at the meter. A fixed list; the organization maps each to a disposition. */
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

/** What billing does with an outcome (M-06). */
export const DISPOSITIONS = ["bill_actual", "estimate", "hold", "standing_only", "skip"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export type OutcomeMapping = Readonly<Partial<Record<ReadingOutcome, Disposition>>>;

/** The default mapping: bill what was read, estimate when the dial could not be read, hold when someone must look. */
export const DEFAULT_OUTCOME_MAPPING: Readonly<Record<ReadingOutcome, Disposition>> = {
  read_ok: "bill_actual",
  meter_inaccessible: "estimate",
  meter_faulty: "estimate",
  no_meter_found: "hold",
  locked_premises: "estimate",
  dog_or_hazard: "estimate",
  customer_refused: "hold",
  illegal_connection_suspected: "hold",
};

/** The disposition for an outcome: the organization's mapping, then the default. Pure. */
export function dispositionFor(outcome: ReadingOutcome, mapping: OutcomeMapping = {}): Disposition {
  return mapping[outcome] ?? DEFAULT_OUTCOME_MAPPING[outcome];
}
