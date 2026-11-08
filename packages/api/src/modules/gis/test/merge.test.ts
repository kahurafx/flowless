import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { EXISTENCE_FIELD, planMerge, valuesEqual, type MergeRow } from "../versioning/merge";

const FIELDS = ["name", "condition", "location"] as const;
const row = (overrides: Partial<MergeRow> = {}): MergeRow => ({
  isDeleted: false,
  name: "Valve",
  condition: "good",
  location: { lat: -1.288, lng: 36.782 },
  ...overrides,
});

describe("valuesEqual", () => {
  it("compares by value, including dates and nested objects", () => {
    assert.ok(valuesEqual({ lat: 1, lng: 2 }, { lat: 1, lng: 2 }));
    assert.ok(!valuesEqual({ lat: 1, lng: 2 }, { lat: 1, lng: 3 }));
    assert.ok(valuesEqual(new Date(1000), new Date(1000)));
    assert.ok(!valuesEqual(new Date(1000), new Date(2000)));
    assert.ok(valuesEqual(null, null));
    assert.ok(!valuesEqual(null, undefined));
    assert.ok(!valuesEqual({ a: 1 }, { a: 1, b: 2 }));
  });
});

describe("planMerge", () => {
  const base = row();

  it("fast-forwards when main hasn't moved since the fork", () => {
    const plan = planMerge({ base, branch: row({ name: "Renamed" }), main: base }, FIELDS);
    assert.ok(plan.kind === "write");
    assert.equal(plan.mode, "fast-forward");
    assert.deepEqual(plan.changedFields, ["name"]);
    assert.equal(plan.values.name, "Renamed");
  });

  it("merges edits to different fields without any conflict", () => {
    const plan = planMerge({ base, branch: row({ name: "Branch name" }), main: row({ condition: "poor" }) }, FIELDS);
    assert.ok(plan.kind === "write");
    assert.equal(plan.mode, "merge");
    assert.equal(plan.values.name, "Branch name");
    assert.equal(plan.values.condition, "poor", "main's concurrent change is kept");
    assert.deepEqual(plan.changedFields, ["name"], "only the branch's own change is new to main");
  });

  it("treats the same edit made on both sides as agreement", () => {
    const plan = planMerge({ base, branch: row({ condition: "critical", name: "B" }), main: row({ condition: "critical" }) }, FIELDS);
    assert.ok(plan.kind === "write");
    assert.equal(plan.values.condition, "critical");
    assert.deepEqual(plan.changedFields, ["name"]);
  });

  it("reports a conflict when both sides changed the same field differently", () => {
    const plan = planMerge({ base, branch: row({ name: "Mine" }), main: row({ name: "Theirs" }) }, FIELDS);
    assert.deepEqual(plan, {
      kind: "conflict",
      conflicts: [{ field: "name", base: "Valve", branch: "Mine", main: "Theirs" }],
    });
  });

  it("collects every conflicting field, not just the first", () => {
    const plan = planMerge({ base, branch: row({ name: "A", condition: "fair" }), main: row({ name: "B", condition: "poor" }) }, FIELDS);
    assert.ok(plan.kind === "conflict");
    assert.deepEqual(
      plan.conflicts.map((c) => c.field),
      ["name", "condition"],
    );
  });

  it("applies per-field resolutions", () => {
    const input = { base, branch: row({ name: "Mine", condition: "fair" }), main: row({ name: "Theirs", condition: "poor" }) };
    const plan = planMerge(input, FIELDS, { name: "branch", condition: "main" });
    assert.ok(plan.kind === "write");
    assert.equal(plan.values.name, "Mine");
    assert.equal(plan.values.condition, "poor");
  });

  it("skips when resolving everything toward main leaves main unchanged", () => {
    const plan = planMerge({ base, branch: row({ name: "Mine" }), main: row({ name: "Theirs" }) }, FIELDS, { name: "main" });
    assert.deepEqual(plan, { kind: "skip", reason: "no-change" });
  });

  it("skips a branch that edited something and put it back", () => {
    assert.deepEqual(planMerge({ base, branch: row(), main: base }, FIELDS), { kind: "skip", reason: "no-change" });
  });

  it("creates an entity that only exists on the branch", () => {
    const plan = planMerge({ base: null, branch: row({ name: "New" }), main: null }, FIELDS);
    assert.ok(plan.kind === "write");
    assert.equal(plan.mode, "create");
    assert.equal(plan.values.name, "New");
  });

  it("ignores an entity that was created and deleted without ever reaching main", () => {
    const plan = planMerge({ base: null, branch: row({ isDeleted: true }), main: null }, FIELDS);
    assert.deepEqual(plan, { kind: "skip", reason: "created-and-deleted-on-branch" });
  });

  it("refuses a branch-created entity that somehow already exists on main", () => {
    assert.throws(() => planMerge({ base: null, branch: row(), main: row() }, FIELDS), /already exists on main/);
  });

  describe("deletion", () => {
    it("deletes when main hasn't touched the entity", () => {
      const plan = planMerge({ base, branch: row({ isDeleted: true }), main: base }, FIELDS);
      assert.ok(plan.kind === "write");
      assert.equal(plan.mode, "delete");
      assert.equal(plan.tombstone, true);
    });

    it("does nothing when both sides deleted it", () => {
      const plan = planMerge({ base, branch: row({ isDeleted: true }), main: row({ isDeleted: true }) }, FIELDS);
      assert.deepEqual(plan, { kind: "skip", reason: "no-change" });
    });

    it("asks for a decision when the branch deleted what main edited", () => {
      const input = { base, branch: row({ isDeleted: true }), main: row({ name: "Edited on main" }) };
      const plan = planMerge(input, FIELDS);
      assert.ok(plan.kind === "conflict");
      assert.equal(plan.conflicts[0]?.field, EXISTENCE_FIELD);

      const deleted = planMerge(input, FIELDS, { [EXISTENCE_FIELD]: "branch" });
      assert.ok(deleted.kind === "write" && deleted.mode === "delete");
      assert.deepEqual(planMerge(input, FIELDS, { [EXISTENCE_FIELD]: "main" }), { kind: "skip", reason: "kept-main" });
    });

    it("asks for a decision when the branch edited what main deleted", () => {
      const input = { base, branch: row({ name: "Edited on branch" }), main: row({ isDeleted: true }) };
      const plan = planMerge(input, FIELDS);
      assert.ok(plan.kind === "conflict");
      assert.equal(plan.conflicts[0]?.field, EXISTENCE_FIELD);

      assert.deepEqual(planMerge(input, FIELDS, { [EXISTENCE_FIELD]: "main" }), { kind: "skip", reason: "kept-main" });
      const restored = planMerge(input, FIELDS, { [EXISTENCE_FIELD]: "branch" });
      assert.ok(restored.kind === "write");
      assert.equal(restored.mode, "restore");
      assert.equal(restored.tombstone, false);
      assert.equal(restored.values.name, "Edited on branch");
    });
  });
});
