import { describe, expect, it } from "vitest";
import { WorkRegistry } from "../../../kernel/work";
import { work } from "../../../wiring";
import { register } from "..";
import { WORK_ORDER_KINDS } from "../kinds";

// After Majimap's work-orders/test/kinds.test.ts; its GIS kinds move to GIS in W3.
describe("Work Orders kinds", () => {
  it("register cleanly, and are offered only with the Work Orders module (level full)", () => {
    const registry = new WorkRegistry();
    register(registry);
    expect(registry.availableKinds(["work-orders"], "full").map((k) => k.key).sort()).toEqual(["inspection_general", "repair", "survey"]);
    expect(registry.availableKinds(["gis"], "basic")).toEqual([]);
    expect(registry.availableKinds([], "none")).toEqual([]);
  });

  it("are wired into the app's registry with the wo- branch adapters", async () => {
    expect(work.getWorkKind("repair")?.module).toBe("work-orders");
    expect(() => register(work)).toThrow(/already registered/);
  });

  it("give every kind a label, and let technicians raise only what they find in the field", () => {
    for (const def of WORK_ORDER_KINDS) expect(def.label.length, def.key).toBeGreaterThan(0);
    expect(WORK_ORDER_KINDS.filter((k) => k.selfRaise).map((k) => k.key).sort()).toEqual(["inspection_general", "repair"]);
  });

  it("check completion data with each kind's capture schema", () => {
    const repair = WORK_ORDER_KINDS.find((k) => k.key === "repair")!;
    expect(repair.capture!.safeParse({ workDone: "Replaced the gasket" }).success).toBe(true);
    expect(repair.capture!.safeParse({ workDone: "" }).success).toBe(false);
    expect(repair.evidence).toEqual({ photos: 1, gps: true });
  });
});
