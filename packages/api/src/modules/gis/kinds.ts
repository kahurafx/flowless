import { defineWorkKind, type WorkKindDef } from "../../kernel/work";

/**
 * GIS's work kinds (W-01), ported from Majimap's work-orders/kinds/gis.ts. All are tier
 * "basic", so an organization licensed for GIS alone gets them. A job's progress is its
 * assets (each pending, or done once an inspection or valve log recorded on the job's
 * branch is linked); route kinds (target "assets") need every asset done to be "done".
 * - logs: condition and valve logs, linked to the job (`workOrders.linkLog`).
 * - edits: changes on the job's branch `wo-<code>`, reviewed, then posted (`gis:post`).
 * - creates: new features on the job's branch; posting makes them live.
 */
export const GIS_WORK_KINDS: readonly WorkKindDef[] = [
  defineWorkKind({ key: "leak", module: "gis", label: "Leak or main break repair", target: "asset", review: "optional", tier: "basic", gis: "logs", selfRaise: true }),
  defineWorkKind({ key: "leak_survey", module: "gis", label: "Active leak detection survey", target: "area", review: "required", tier: "basic", gis: "logs" }),
  defineWorkKind({ key: "valve_replacement", module: "gis", label: "Valve replacement", target: "asset", review: "required", tier: "basic", gis: "edits" }),
  defineWorkKind({ key: "valve_exercise", module: "gis", label: "Valve exercising", target: "assets", review: "optional", tier: "basic", gis: "logs" }),
  defineWorkKind({ key: "flushing", module: "gis", label: "Network flushing", target: "asset", review: "none", tier: "basic", gis: "logs" }),
  // A technician who finds something worth a closer look raises one for themselves.
  defineWorkKind({ key: "inspection", module: "gis", label: "Condition assessment", target: "asset", review: "optional", tier: "basic", gis: "logs", selfRaise: true }),
  defineWorkKind({ key: "prv_adjustment", module: "gis", label: "Pressure reducing valve adjustment", target: "asset", review: "required", tier: "basic", gis: "logs" }),
  defineWorkKind({ key: "facility_service", module: "gis", label: "Facility servicing", target: "asset", review: "required", tier: "basic", gis: "logs" }),
  defineWorkKind({ key: "asset_capture", module: "gis", label: "Capture a new asset", target: "location", review: "required", tier: "basic", gis: "creates", selfRaise: true }),
  // Majimap's customer_capture: GIS captures the connection only; Accounts owns customers.
  defineWorkKind({
    key: "connection_capture",
    module: "gis",
    label: "Capture a service connection",
    target: "location",
    review: "required",
    tier: "basic",
    gis: "creates",
    selfRaise: true,
  }),
  defineWorkKind({ key: "asset_update", module: "gis", label: "Correct or replace an asset record", target: "asset", review: "required", tier: "basic", gis: "edits", selfRaise: true }),
];
