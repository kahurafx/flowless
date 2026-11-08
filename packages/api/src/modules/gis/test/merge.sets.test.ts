import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { planMerge, type MergeRow } from "../versioning/merge";

const FIELDS = ["name", "valves"] as const;
const OPTIONS = { setFields: ["valves"] } as const;

const row = (valves: string[], overrides: Partial<MergeRow> = {}): MergeRow => ({
  isDeleted: false,
  name: "DMA",
  valves,
  ...overrides,
});

describe("planMerge with a set field", () => {
  it("keeps additions made on both sides", () => {
    const plan = planMerge({ base: row(["a"]), branch: row(["a", "c"]), main: row(["a", "d"]) }, FIELDS, {}, OPTIONS);
    assert.ok(plan.kind === "write");
    assert.equal(plan.mode, "merge");
    assert.deepEqual(plan.values.valves, ["a", "c", "d"]);
    assert.deepEqual(plan.changedFields, ["valves"]);
  });

  it("applies a removal made on the branch to main's set, keeping what main added", () => {
    const plan = planMerge({ base: row(["a", "b"]), branch: row(["a"]), main: row(["a", "b", "d"]) }, FIELDS, {}, OPTIONS);
    assert.ok(plan.kind === "write");
    assert.deepEqual(plan.values.valves, ["a", "d"]);
  });

  it("isn't a conflict when both sides removed the same item", () => {
    const plan = planMerge({ base: row(["a", "b"]), branch: row(["a"]), main: row(["a"]) }, FIELDS, {}, OPTIONS);
    assert.deepEqual(plan, { kind: "skip", reason: "no-change" });
  });

  it("never conflicts, even when the branch adds back what main removed", () => {
    // The branch didn't touch "b", so main's removal of it stands; the branch's own addition lands.
    const plan = planMerge({ base: row(["a", "b"]), branch: row(["a", "b", "c"]), main: row(["a"]) }, FIELDS, {}, OPTIONS);
    assert.ok(plan.kind === "write");
    assert.deepEqual(plan.values.valves, ["a", "c"]);
  });

  it("fast-forwards when only the branch changed the set", () => {
    const plan = planMerge({ base: row(["a"]), branch: row(["a", "b"]), main: row(["a"]) }, FIELDS, {}, OPTIONS);
    assert.ok(plan.kind === "write");
    assert.equal(plan.mode, "fast-forward");
    assert.deepEqual(plan.values.valves, ["a", "b"]);
  });

  it("still reports a scalar conflict next to a set that merged cleanly", () => {
    const plan = planMerge(
      {
        base: row(["a"], { name: "Base" }),
        branch: row(["a", "b"], { name: "Mine" }),
        main: row(["a", "c"], { name: "Theirs" }),
      },
      FIELDS,
      {},
      OPTIONS,
    );
    assert.ok(plan.kind === "conflict");
    assert.deepEqual(
      plan.conflicts.map((c) => c.field),
      ["name"],
      "the set is never the problem",
    );
  });

  it("returns the merged set sorted, whatever order it came in", () => {
    const plan = planMerge({ base: row([]), branch: row(["z", "m"]), main: row([]) }, FIELDS, {}, OPTIONS);
    assert.ok(plan.kind === "write");
    assert.deepEqual(plan.values.valves, ["m", "z"]);
  });

  it("treats a missing set as empty", () => {
    const noValves = { isDeleted: false, name: "DMA" } as MergeRow;
    const plan = planMerge({ base: noValves, branch: row(["a"]), main: noValves }, FIELDS, {}, OPTIONS);
    assert.ok(plan.kind === "write");
    assert.deepEqual(plan.values.valves, ["a"]);
  });

  it("without the option, a set is just an ordinary value and can conflict", () => {
    const plan = planMerge({ base: row(["a"]), branch: row(["a", "b"]), main: row(["a", "c"]) }, FIELDS);
    assert.ok(plan.kind === "conflict");
  });
});
