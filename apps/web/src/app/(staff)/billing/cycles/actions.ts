"use server";

import { billingAction } from "@/data/billing-run";
import { CYCLE_STATES, isPeriod, moveNeedsReason, type CycleStateKey } from "@/lib/cycle-view";
import { optionalText } from "@/lib/optional-text";

/*
 * Server actions for billing cycles (B-02 to B-04, B-16). Every command carries the id its
 * dialog minted, so a retried submit replays. `billing:run` is checked by the procedures; a
 * refusal (a skip without a reason, closing with unexplained accounts, a bill awaiting a
 * decision) is the dialog's message.
 */

export async function openCycleAction(input: { id: string; routeId: string; period: string; cycleDate: string }) {
  if (!isPeriod(input.period)) return { error: "Enter the period as year and month, like 2026-05" } as const;
  if (!input.routeId) return { error: "Choose a route" } as const;
  return billingAction((api) =>
    api.billing.cycles
      .open({ id: input.id, routeId: input.routeId, period: input.period, ...(input.cycleDate ? { cycleDate: input.cycleDate } : {}) })
      .then((r) => ({ id: r.cycle.id, replayed: r.replayed, accounts: r.accounts, expected: r.expected })),
  );
}

export async function advanceCycleAction(input: { id: string; cycleId: string; from: CycleStateKey; to: string; reason: string }) {
  const to = CYCLE_STATES.find((s) => s === input.to);
  if (!to) return { error: "Choose a state" } as const;
  if (moveNeedsReason(input.from, to) && !input.reason.trim()) return { error: "Skipping ahead or going back needs a reason" } as const;
  return billingAction((api) => api.billing.cycles.advance({ id: input.id, cycleId: input.cycleId, to, ...optionalText("reason", input.reason) }).then(() => null));
}

export async function closeCycleAction(input: { id: string; cycleId: string; note: string }) {
  return billingAction((api) => api.billing.cycles.close({ id: input.id, cycleId: input.cycleId, ...optionalText("note", input.note) }).then(() => null));
}

/** Queues the per-account jobs for accounts with no outcome; `retry` also those whose newest outcome is an exception. Safe to repeat. */
export async function runCycleAction(input: { cycleId: string; retry: boolean }) {
  return billingAction((api) => (input.retry ? api.billing.cycles.retry({ cycleId: input.cycleId }) : api.billing.cycles.run({ cycleId: input.cycleId })).then((r) => r));
}

export async function bulkApproveAction(input: { cycleId: string }) {
  return billingAction((api) => api.billing.cycles.review.bulkApprove({ cycleId: input.cycleId }));
}

export async function decideBillAction(input: { cycleId: string; accountId: string; decision: "approve" | "hold"; basis: "sample" | "individual"; reason: string }) {
  if (input.decision === "hold" && !input.reason.trim()) return { error: "Say why the bill is held" } as const;
  return billingAction((api) =>
    api.billing.cycles.review.decide({ cycleId: input.cycleId, accountId: input.accountId, decision: input.decision, basis: input.basis, ...optionalText("reason", input.reason) }).then(() => null),
  );
}
