import { COMMERCIAL_STATUSES, SERVICE_STATES, type CommercialStatus, type ServiceState } from "@flowless/shared-types";
import { describe, expect, it } from "vitest";
import { COMMERCIAL_MOVES, planCommand, planStatusCommand, stateIsValid, STATUS_COMMANDS, type AccountState, type PlanContext, type StatusCommand } from "./lifecycle";

// C-03: the account state machine.

const live = (commercial: CommercialStatus, service: ServiceState): AccountState => ({
  commercial,
  service,
  serviceReason: service === "CONNECTED" ? null : "Because",
});
/** Every state the two axes allow. */
const validStates = COMMERCIAL_STATUSES.flatMap((c) => SERVICE_STATES.map((s) => live(c, s))).filter(stateIsValid);
const contexts: PlanContext[] = [
  { paymentGate: false, override: false },
  { paymentGate: true, override: false },
  { paymentGate: true, override: true },
];
const key = (s: AccountState) => `${s.commercial}+${s.service}`;

/** The expected outcome of every command from every valid state, written out as a table. */
const ALLOWED: Record<StatusCommand, string[]> = {
  mark_pending_payment: ["NEW+DISCONNECTED"],
  activate: ["NEW+DISCONNECTED", "PENDING_PAYMENT+DISCONNECTED"],
  make_dormant: ["ACTIVE+CONNECTED", "ACTIVE+DISCONNECTED"],
  reactivate: ["DORMANT+CONNECTED", "DORMANT+DISCONNECTED"],
  terminate: [
    "NEW+DISCONNECTED",
    "PENDING_PAYMENT+DISCONNECTED",
    "ACTIVE+CONNECTED",
    "ACTIVE+DISCONNECTED",
    "DORMANT+CONNECTED",
    "DORMANT+DISCONNECTED",
  ],
  disconnect_service: ["ACTIVE+CONNECTED", "DORMANT+CONNECTED"],
  reconnect_service: ["ACTIVE+DISCONNECTED"],
};

describe("account state machine (C-03)", () => {
  it("has seven valid states with a live service only for active and dormant accounts", () => {
    expect(validStates.map(key)).toEqual([
      "NEW+DISCONNECTED",
      "PENDING_PAYMENT+DISCONNECTED",
      "ACTIVE+CONNECTED",
      "ACTIVE+DISCONNECTED",
      "DORMANT+CONNECTED",
      "DORMANT+DISCONNECTED",
      "TERMINATED+DISCONNECTED",
    ]);
  });

  for (const kind of STATUS_COMMANDS) {
    it(`${kind}: allowed from exactly the listed states, whatever the payment gate (table-driven)`, () => {
      const accepted = new Set<string>();
      for (const state of validStates) {
        for (const ctx of contexts) {
          const plan = planCommand(state, { kind, reason: "Because" }, ctx);
          // NEW to ACTIVE is the one move that depends on the payment gate.
          const gated = kind === "activate" && state.commercial === "NEW" && ctx.paymentGate && !ctx.override;
          if (plan.ok) {
            expect(gated).toBe(false);
            accepted.add(key(state));
          } else if (!gated) {
            expect(plan.problem).toBeTruthy();
          }
        }
      }
      expect([...accepted].sort()).toEqual([...ALLOWED[kind]].sort());
    });
  }

  it("moves commercial status exactly as the table says", () => {
    const expected: Record<string, CommercialStatus> = {
      mark_pending_payment: "PENDING_PAYMENT",
      activate: "ACTIVE",
      make_dormant: "DORMANT",
      reactivate: "ACTIVE",
      terminate: "TERMINATED",
    };
    for (const state of validStates) {
      for (const kind of STATUS_COMMANDS) {
        const plan = planCommand(state, { kind, reason: "Because" }, { paymentGate: false, override: false });
        if (!plan.ok) continue;
        expect(plan.to.commercial).toBe(expected[kind] ?? state.commercial);
        expect(COMMERCIAL_MOVES[kind].from).toContain(state.commercial);
      }
    }
  });

  it("planStatusCommand is planCommand plus the kind and the status it starts from", () => {
    for (const state of validStates) {
      for (const kind of STATUS_COMMANDS) {
        for (const ctx of contexts) {
          const input = { kind, reason: "Because" };
          const plain = planCommand(state, input, ctx);
          const plan = planStatusCommand(state, input, ctx);
          if (!plain.ok) {
            expect(plan).toEqual(plain);
            continue;
          }
          expect(plan).toEqual({ ok: true, kind, from: state.commercial, to: plain.to });
        }
      }
    }
  });

  it("activation connects the service unless told otherwise, and then needs a reason", () => {
    const fresh = live("PENDING_PAYMENT", "DISCONNECTED");
    const ctx = { paymentGate: true, override: false };
    expect(planCommand(fresh, { kind: "activate", reason: "Gates met" }, ctx)).toEqual({
      ok: true,
      to: { commercial: "ACTIVE", service: "CONNECTED", serviceReason: null },
    });
    expect(planCommand(fresh, { kind: "activate", reason: "Gates met", connect: false }, ctx)).toMatchObject({ ok: false });
    expect(planCommand(fresh, { kind: "activate", reason: "Gates met", connect: false, serviceReason: "Customer asked to wait" }, ctx)).toEqual({
      ok: true,
      to: { commercial: "ACTIVE", service: "DISCONNECTED", serviceReason: "Customer asked to wait" },
    });
  });

  it("skips pending payment only without a payment gate (or with an override)", () => {
    const fresh = live("NEW", "DISCONNECTED");
    expect(planCommand(fresh, { kind: "activate", reason: "Go" }, { paymentGate: false, override: false }).ok).toBe(true);
    expect(planCommand(fresh, { kind: "activate", reason: "Go" }, { paymentGate: true, override: false })).toMatchObject({ ok: false });
    expect(planCommand(fresh, { kind: "activate", reason: "Go" }, { paymentGate: true, override: true }).ok).toBe(true);
  });

  it("keeps a dormant account's service status, and still lets it be disconnected", () => {
    const ctx = { paymentGate: false, override: false };
    expect(planCommand(live("ACTIVE", "CONNECTED"), { kind: "make_dormant", reason: "Away" }, ctx)).toMatchObject({ ok: true, to: { commercial: "DORMANT", service: "CONNECTED" } });
    expect(planCommand(live("ACTIVE", "DISCONNECTED"), { kind: "make_dormant", reason: "Away" }, ctx)).toMatchObject({ ok: true, to: { commercial: "DORMANT", service: "DISCONNECTED", serviceReason: "Because" } });
    expect(planCommand(live("DORMANT", "CONNECTED"), { kind: "disconnect_service", reason: "Unpaid" }, ctx)).toMatchObject({
      ok: true,
      to: { commercial: "DORMANT", service: "DISCONNECTED", serviceReason: "Unpaid" },
    });
    expect(planCommand(live("DORMANT", "DISCONNECTED"), { kind: "reconnect_service", reason: "Back" }, ctx)).toMatchObject({ ok: false });
    expect(planCommand(live("DORMANT", "DISCONNECTED"), { kind: "reactivate", reason: "Back" }, ctx)).toMatchObject({ ok: true, to: { commercial: "ACTIVE", service: "DISCONNECTED" } });
  });

  it("terminates into a disconnected, terminal state carrying the reason", () => {
    const plan = planCommand(live("ACTIVE", "CONNECTED"), { kind: "terminate", reason: "Moved away" }, contexts[0]!);
    expect(plan).toEqual({ ok: true, to: { commercial: "TERMINATED", service: "DISCONNECTED", serviceReason: "Account terminated: Moved away" } });
  });

  it("refuses every command from TERMINATED, with every context", () => {
    for (const kind of STATUS_COMMANDS) {
      for (const ctx of contexts) {
        expect(planCommand(live("TERMINATED", "DISCONNECTED"), { kind, reason: "Again", connect: true }, ctx)).toMatchObject({ ok: false });
      }
    }
  });

  it("refuses a blank reason for every command", () => {
    for (const state of validStates) {
      for (const kind of STATUS_COMMANDS) {
        expect(planCommand(state, { kind, reason: "   " }, contexts[0]!)).toMatchObject({ ok: false });
      }
    }
  });

  // Property test: random walks through the machine never leave the valid states, never leave
  // TERMINATED, and only ever make a move the table lists.
  it("holds the invariants over random sequences of commands (seeded)", () => {
    let seed = 20260711;
    const next = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
    const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!;
    for (let walk = 0; walk < 300; walk++) {
      let state = live("NEW", "DISCONNECTED");
      let terminated = false;
      for (let step = 0; step < 25; step++) {
        const kind = pick(STATUS_COMMANDS);
        const ctx: PlanContext = { paymentGate: next() < 0.5, override: next() < 0.2 };
        const connect = next() < 0.7;
        const plan = planCommand(state, { kind, reason: "r", connect, serviceReason: connect ? undefined : "why" }, ctx);
        if (terminated) expect(plan.ok).toBe(false);
        if (!plan.ok) continue;
        expect(stateIsValid(plan.to)).toBe(true);
        expect(ALLOWED[kind]).toContain(key(state));
        state = plan.to;
        if (state.commercial === "TERMINATED") terminated = true;
      }
      if (terminated) expect(state.commercial).toBe("TERMINATED");
    }
  });
});
