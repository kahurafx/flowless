/*
 * Billing cycle display helpers (B-02, B-04, B-16). Pure. The state table mirrors the API's
 * `cycle-machine.ts` as wayfinding for the buttons; the procedure decides (and the database
 * enforces the same table).
 */

export const CYCLE_STATES = ["open", "reading_window", "validation", "estimation", "calculation", "review", "issue", "deliver", "completeness", "closed"] as const;
export type CycleStateKey = (typeof CYCLE_STATES)[number];

export const CYCLE_STATE_LABELS: Record<CycleStateKey, string> = {
  open: "Open",
  reading_window: "Reading window",
  validation: "Validation",
  estimation: "Estimation",
  calculation: "Calculation",
  review: "Review",
  issue: "Issue",
  deliver: "Deliver",
  completeness: "Completeness check",
  closed: "Closed",
};

export const CYCLE_OUTCOMES = ["billed", "billed_estimate", "exception", "excluded"] as const;
export type CycleOutcomeKey = (typeof CYCLE_OUTCOMES)[number];

export const OUTCOME_LABELS: Record<CycleOutcomeKey | "none", string> = {
  billed: "Billed",
  billed_estimate: "Billed on an estimate",
  exception: "Exception",
  excluded: "Excluded",
  none: "No outcome yet",
};

export const FREQUENCY_LABELS = { monthly: "Monthly", bimonthly: "Every two months", quarterly: "Every three months" } as const;
export const TRIGGER_LABELS = { batch: "Batch", on_reading: "On each reading" } as const;

/** Where the cycle's accounts came from (B-03). */
export function eligibilitySourceLabel(source: "metering_snapshot" | "accounts_fallback"): { label: string; detail: string } {
  return source === "metering_snapshot"
    ? { label: "Metering snapshot", detail: "The accounts were fixed by the eligibility snapshot the reading tasks share." }
    : { label: "Accounts fallback", detail: "Metering is not licensed, so every account with a live service point that is billed for consumption is expected; there is no meter register to ask." };
}

const index = (s: CycleStateKey) => CYCLE_STATES.indexOf(s);

export interface MoveOptions {
  /** The next state in the normal run (null at the completeness check, where only close remains, and when closed). */
  next: CycleStateKey | null;
  /** States that can be skipped to or gone back to; both need a reason. */
  skip: CycleStateKey[];
  back: CycleStateKey[];
  /** Close is offered from the completeness check. */
  canClose: boolean;
}

/** What the buttons offer from a state: `closed` is only reached by close, a cycle never returns to open. */
export function moveOptions(state: CycleStateKey): MoveOptions {
  if (state === "closed") return { next: null, skip: [], back: [], canClose: false };
  const pos = index(state);
  const reachable = CYCLE_STATES.filter((s) => s !== "closed" && s !== "open");
  const next = CYCLE_STATES[pos + 1];
  const nextState = next && next !== "closed" ? next : null;
  return {
    next: nextState,
    skip: reachable.filter((s) => index(s) > pos + 1),
    back: reachable.filter((s) => index(s) < pos),
    canClose: state === "completeness",
  };
}

/** Whether moving to `to` needs a reason: anything but the very next state. */
export function moveNeedsReason(from: CycleStateKey, to: CycleStateKey): boolean {
  return index(to) !== index(from) + 1;
}

export const isPeriod = (text: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(text);

/** The period (YYYY-MM) before `today` (YYYY-MM-DD): what a route is usually billed for. */
export function previousPeriod(today: string): string {
  const [y, m] = today.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function periodLabel(period: string, locale: string): string {
  if (!isPeriod(period)) return period;
  const [y, m] = period.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** Share of `part` in `whole` as a whole percent (an empty whole is complete). */
export const percentOf = (part: number, whole: number) => (whole === 0 ? 100 : Math.floor((part * 100) / whole));
