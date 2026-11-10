import { describe, expect, it } from "vitest";
import { CYCLE_STATES, nextState, planClose, planMove, type CycleState } from "./cycle-machine";

// B-02: the cycle state machine, table-driven and by random walk.

const pos = (s: CycleState) => CYCLE_STATES.indexOf(s);

describe("billing cycle state machine (B-02)", () => {
  it("runs open, reading window, validation, estimation, calculation, review, issue, deliver, completeness, closed", () => {
    expect(CYCLE_STATES).toEqual(["open", "reading_window", "validation", "estimation", "calculation", "review", "issue", "deliver", "completeness", "closed"]);
    expect(nextState("open")).toBe("reading_window");
    expect(nextState("completeness")).toBe("closed");
    expect(nextState("closed")).toBeNull();
  });

  it("advances one step without a reason", () => {
    for (const from of CYCLE_STATES.slice(0, -2)) expect(planMove(from, nextState(from)!)).toEqual({ ok: true, kind: "advance" });
  });

  it("refuses to advance into closed (that is the close command), and from closed to anything", () => {
    expect(planMove("completeness", "closed")).toMatchObject({ ok: false });
    for (const to of CYCLE_STATES) expect(planMove("closed", to, "why")).toMatchObject({ ok: false });
  });

  it("skips forward and goes back only with a reason", () => {
    expect(planMove("validation", "calculation")).toMatchObject({ ok: false, problem: expect.stringMatching(/reason/) });
    expect(planMove("validation", "calculation", "  ")).toMatchObject({ ok: false });
    expect(planMove("validation", "calculation", "no estimates needed")).toEqual({ ok: true, kind: "skip" });
    expect(planMove("review", "validation")).toMatchObject({ ok: false });
    expect(planMove("review", "validation", "late readings")).toEqual({ ok: true, kind: "retreat" });
  });

  it("never goes back to open, and never stays put", () => {
    expect(planMove("review", "open", "x")).toMatchObject({ ok: false });
    for (const s of CYCLE_STATES) expect(planMove(s, s, "x")).toMatchObject({ ok: false });
  });

  it("closes only from completeness", () => {
    for (const s of CYCLE_STATES) expect(planClose(s).ok).toBe(s === "completeness");
  });

  it("table: every pair has exactly the expected result", () => {
    for (const from of CYCLE_STATES) {
      for (const to of CYCLE_STATES) {
        const plan = planMove(from, to, "reason");
        const allowed = from !== "closed" && to !== "closed" && to !== "open" && to !== from;
        expect(plan.ok, `${from} -> ${to}`).toBe(allowed);
        if (plan.ok) expect(plan.kind).toBe(pos(to) === pos(from) + 1 ? "advance" : pos(to) > pos(from) ? "skip" : "retreat");
      }
    }
  });

  it("random walks stay in the machine: closed is absorbing and a close is always from completeness (seeded)", () => {
    let seed = 20261110;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
    for (let walk = 0; walk < 200; walk += 1) {
      let state: CycleState = "open";
      for (let steps = 0; steps < 60 && state !== "closed"; steps += 1) {
        if (rnd() < 0.15) {
          if (planClose(state).ok) {
            expect(state).toBe("completeness");
            state = "closed";
          }
          continue;
        }
        const to = CYCLE_STATES[Math.floor(rnd() * CYCLE_STATES.length)]!;
        const plan = planMove(state, to, rnd() < 0.5 ? "because" : undefined);
        if (plan.ok) {
          expect(to).not.toBe("open");
          expect(to).not.toBe("closed");
          state = to;
        }
      }
      if (state === "closed") for (const to of CYCLE_STATES) expect(planMove(state, to, "x").ok).toBe(false);
    }
  });
});
