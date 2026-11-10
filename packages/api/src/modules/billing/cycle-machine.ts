import { CYCLE_STATES, type CycleEventKind, type CycleState } from "@flowless/db/schema/billing";

/*
 * The billing cycle's state machine (B-02), pure: no I/O, no clock. `cycles.ts` runs it under
 * the cycle's row lock and writes the event; the database trigger `guard_cycle_event` enforces
 * the same table, so a path that skips it is impossible.
 *
 *   open -> reading_window -> validation -> estimation -> calculation -> review -> issue
 *        -> deliver -> completeness -> closed
 *
 * - `advance`: to the next state, no reason needed.
 * - `skip`: forward over one or more states (for example no estimation needed), reason required.
 * - `retreat`: back to an earlier state (not `open`), reason required, for example late readings.
 * - `close`: only from `completeness`, through its own command (B-04's check runs first).
 * - `closed` is terminal: the period is locked (B-15) and corrections are documents (B-14).
 */

export { CYCLE_STATES, type CycleState };

export const CYCLE_STATE_LABELS: Record<CycleState, string> = {
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

export type MovePlan = { ok: true; kind: Exclude<CycleEventKind, "open" | "close"> } | { ok: false; problem: string };

const position = (s: CycleState) => CYCLE_STATES.indexOf(s);

/** The state that follows `from` in the normal run, or null at the end. */
export function nextState(from: CycleState): CycleState | null {
  return CYCLE_STATES[position(from) + 1] ?? null;
}

/** What moving from one state to another is, or why it is refused. `close` is not a move: see `planClose`. */
export function planMove(from: CycleState, to: CycleState, reason?: string): MovePlan {
  if (from === "closed") return { ok: false, problem: "A closed cycle does not move; correct a bill with a credit note, debit note or re-bill" };
  if (to === from) return { ok: false, problem: `The cycle is already in ${CYCLE_STATE_LABELS[from]}` };
  if (to === "closed") return { ok: false, problem: "Close the cycle with the close command, from the completeness check" };
  if (to === "open") return { ok: false, problem: "A cycle cannot go back to open" };
  const why = (reason ?? "").trim();
  const next = nextState(from);
  if (to === next) return { ok: true, kind: "advance" };
  if (position(to) > position(from)) return why ? { ok: true, kind: "skip" } : { ok: false, problem: `Skipping to ${CYCLE_STATE_LABELS[to]} needs a reason` };
  return why ? { ok: true, kind: "retreat" } : { ok: false, problem: `Going back to ${CYCLE_STATE_LABELS[to]} needs a reason` };
}

export function planClose(from: CycleState): { ok: true } | { ok: false; problem: string } {
  if (from === "closed") return { ok: false, problem: "The cycle is already closed" };
  if (from !== "completeness") return { ok: false, problem: `A cycle closes from the completeness check, not from ${CYCLE_STATE_LABELS[from]}` };
  return { ok: true };
}
