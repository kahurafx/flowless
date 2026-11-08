import { describe, expect, it } from "vitest";
import { captureProblem, captureValue, dueLabel, finishOutcomes, rankOrders, usesJobBranch } from "./work-orders";
import type { WorkKind, WorkOrder } from "./types";

const order = (over: Partial<WorkOrder>): WorkOrder =>
  ({ id: "o", priority: "normal", status: "pending", dueAt: new Date("2026-01-10"), location: null, assetId: null, assets: [], ...over }) as WorkOrder;

describe("ranking", () => {
  const here = { lat: 0, lng: 0 };
  it("puts a started job first, then priority, then the nearest", () => {
    const ranked = rankOrders(
      [
        order({ id: "far", location: { latitude: 0, longitude: 0.05 } }),
        order({ id: "near", location: { latitude: 0, longitude: 0.001 } }),
        order({ id: "urgent", priority: "urgent", location: { latitude: 0, longitude: 0.5 } }),
        order({ id: "started", status: "in_progress", priority: "low" }),
      ],
      [],
      here,
    );
    expect(ranked.map((r) => r.order.id)).toEqual(["started", "urgent", "near", "far"]);
  });

  it("falls back to the due date without a position", () => {
    const ranked = rankOrders([order({ id: "later", dueAt: new Date("2026-02-01") }), order({ id: "sooner", dueAt: new Date("2026-01-02") })], [], null);
    expect(ranked.map((r) => r.order.id)).toEqual(["sooner", "later"]);
  });

  it("places a job by its asset when it has no position of its own", () => {
    const [r] = rankOrders([order({ assetId: "n1" })], [{ id: "n1", location: { lat: 0, lng: 0.001 } }], here);
    expect(r?.distanceM).toBeGreaterThan(100);
  });
});

describe("finishing", () => {
  it("a route job is done only once every asset is", () => {
    const o = order({ assets: [{ status: "done" }, { status: "pending" }] as WorkOrder["assets"] });
    expect(finishOutcomes(o, { target: "assets" })).toEqual([{ outcome: "done", disabled: true, hint: "1 asset still to do" }, { outcome: "partial" }]);
    expect(finishOutcomes(o, { target: "asset" }).map((x) => x.outcome)).toEqual(["done", "no_fault"]);
  });

  it("collects the completion data a kind needs, and says what is missing", () => {
    const repair = { key: "repair", hasCapture: true };
    expect(captureProblem(repair, { workDone: "  " })).toBe("Fill in: what was done");
    expect(captureProblem(repair, { workDone: "Replaced the coupling" })).toBeNull();
    expect(captureValue(repair, { workDone: " Replaced the coupling " })).toEqual({ workDone: "Replaced the coupling", materials: "" });
    expect(captureProblem({ key: "inspection", hasCapture: false }, {})).toBeNull();
    expect(captureValue({ key: "inspection", hasCapture: false }, {})).toBeUndefined();
    expect(captureProblem({ key: "something_new", hasCapture: true }, {})).toMatch(/Finish it on the web/);
  });

  it("only GIS kinds work on the job's branch", () => {
    expect(usesJobBranch({ gis: "logs" } as WorkKind)).toBe(true);
    expect(usesJobBranch({ gis: "none" } as WorkKind)).toBe(false);
    expect(usesJobBranch(undefined)).toBe(false);
  });
});

describe("due", () => {
  it("reads overdue, hours and days", () => {
    const now = new Date("2026-01-10T12:00:00Z").getTime();
    expect(dueLabel("2026-01-10T00:00:00Z", now)).toEqual({ text: "Overdue", overdue: true });
    expect(dueLabel("2026-01-10T15:00:00Z", now)).toEqual({ text: "Due in 3 h", overdue: false });
    expect(dueLabel("2026-01-13T12:00:00Z", now)).toEqual({ text: "Due in 3 d", overdue: false });
  });
});
