import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { junctionColumns, junctionFromRow, JunctionSchema } from "../junction";

describe("JunctionSchema", () => {
  it("accepts equal and reduced junctions", () => {
    assert.ok(JunctionSchema.safeParse({ type: "tee", mainSizeMm: 200, branchSizeMm: null }).success);
    assert.ok(JunctionSchema.safeParse({ type: "tee", mainSizeMm: 200, branchSizeMm: 100 }).success);
  });

  it("rejects a smaller size that isn't smaller", () => {
    assert.equal(JunctionSchema.safeParse({ type: "tee", mainSizeMm: 200, branchSizeMm: 200 }).success, false);
    assert.equal(JunctionSchema.safeParse({ type: "tee", mainSizeMm: 200, branchSizeMm: 250 }).success, false);
  });

  it("requires a reducer to step down", () => {
    assert.equal(JunctionSchema.safeParse({ type: "reducer", mainSizeMm: 200, branchSizeMm: null }).success, false);
  });
});

describe("junction columns", () => {
  it("round-trips a spec, and none is all NULL", () => {
    const spec = { type: "wye" as const, mainSizeMm: 150, branchSizeMm: 100 };
    assert.deepEqual(junctionFromRow(junctionColumns(spec)), spec);
    assert.deepEqual(junctionColumns(null), { junctionType: null, mainSizeMm: null, branchSizeMm: null });
    assert.equal(junctionFromRow(junctionColumns(null)), null);
  });
});
