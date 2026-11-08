import { effectivePermissions, ROLES, type Permission, type WorkOrderStatus } from "@flowless/shared-types";
import { describe, expect, it } from "vitest";
import type { WorkKindDef } from "../../../kernel/work";
import { abilitiesOf } from "../access";
import { canAddAsset, planCreate, type CreateRequest } from "../rules";

// Ported from Majimap's work-orders/test/rules.test.ts, with permissions in place of roles.
const kind = (overrides: Partial<WorkKindDef> = {}): WorkKindDef => ({
  key: "leak",
  module: "gis",
  label: "Leak",
  target: "asset",
  review: "optional",
  tier: "basic",
  gis: "logs",
  selfRaise: true,
  ...overrides,
});
const can = (...permissions: Permission[]) => abilitiesOf(new Set(permissions));
const manager = can("work_orders:read", "work_orders:assign", "work_orders:review", "work_orders:cancel");
const request = (overrides: Partial<CreateRequest> = {}): CreateRequest => ({
  abilities: manager,
  userId: "me",
  level: "basic",
  kind: kind(),
  priority: "normal",
  assigneeId: null,
  ...overrides,
});

describe("planCreate: managers", () => {
  it("lets members with work_orders:assign raise any job for anyone, with the kind's own review policy", () => {
    for (const role of ["owner", "supervisor", "gis_engineer"] as const) {
      expect(
        planCreate(request({ abilities: abilitiesOf(effectivePermissions(role, [])), assigneeId: "other", priority: "urgent", kind: kind({ selfRaise: false }) })),
        role,
      ).toEqual({ ok: true, assigneeId: "other", review: "optional", selfRaised: false });
    }
  });

  it("may leave a job unassigned, as a managers' pool item", () => {
    expect(planCreate(request())).toEqual({ ok: true, assigneeId: null, review: "optional", selfRaised: false });
  });
});

describe("planCreate: technicians raising a job they found", () => {
  const tech = (overrides: Partial<CreateRequest> = {}) => request({ abilities: can("work_orders:execute"), userId: "me", ...overrides });

  it("assigns it to themselves and always requires review, even for a kind that needs none", () => {
    expect(planCreate(tech({ kind: kind({ review: "none" }) }))).toEqual({ ok: true, assigneeId: "me", review: "required", selfRaised: true });
    expect(planCreate(tech({ assigneeId: "me" }))).toEqual({ ok: true, assigneeId: "me", review: "required", selfRaised: true });
  });

  it("refuses raising work for someone else, escalating priority, or a kind only a supervisor raises", () => {
    for (const overrides of [{ assigneeId: "other" }, { priority: "high" as const }, { priority: "urgent" as const }, { kind: kind({ selfRaise: false }) }]) {
      expect(planCreate(tech(overrides)), JSON.stringify(overrides)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
  });
});

describe("planCreate: tiers and permissions", () => {
  it("keeps full-tier kinds for organizations with the Work Orders module", () => {
    expect(planCreate(request({ kind: kind({ tier: "full" }), level: "basic" }))).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(planCreate(request({ kind: kind({ tier: "full" }), level: "full" })).ok).toBe(true);
  });

  it("refuses someone who can only read, and an organization with no work orders", () => {
    expect(planCreate(request({ abilities: can("work_orders:read") })).ok).toBe(false);
    expect(planCreate(request({ level: "none" })).ok).toBe(false);
  });

  it("has an answer for every default role", () => {
    for (const role of ROLES) expect(typeof planCreate(request({ abilities: abilitiesOf(effectivePermissions(role, [])) })).ok).toBe("boolean");
  });
});

describe("canAddAsset", () => {
  it("lets anyone working a job add the valves they find, before it starts, while in progress or on hold", () => {
    for (const status of ["pending", "in_progress", "blocked"] as const) expect(canAddAsset(status), status).toBe(true);
  });

  it("locks the asset list while a job awaits review and once it's finished", () => {
    for (const status of ["submitted", "completed", "cancelled"] as WorkOrderStatus[]) expect(canAddAsset(status), status).toBe(false);
  });
});
