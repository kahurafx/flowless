import { z } from "zod";
import { defineWorkKind, type WorkKindDef } from "../../kernel/work";

/**
 * The Work Orders module's own kinds (W-01): generic field work, available with the Work
 * Orders module (tier full). Completing one publishes `work_order.completed`; GIS,
 * Metering and the rest register their own kinds when they ship.
 */
export const WORK_ORDER_KINDS: readonly WorkKindDef[] = [
  defineWorkKind({
    key: "repair",
    module: "work-orders",
    label: "Repair",
    target: "asset",
    review: "optional",
    tier: "full",
    gis: "none",
    selfRaise: true,
    capture: z.object({ workDone: z.string().trim().min(1, "Say what was done"), materials: z.string().trim().max(2000).default("") }),
    evidence: { photos: 1, gps: true },
    defaultPriority: "high",
    slaHours: 72,
  }),
  defineWorkKind({
    key: "inspection_general",
    module: "work-orders",
    label: "Inspection",
    target: "asset",
    review: "none",
    tier: "full",
    gis: "none",
    selfRaise: true,
    slaHours: 168,
  }),
  defineWorkKind({
    key: "survey",
    module: "work-orders",
    label: "Survey",
    target: "area",
    review: "required",
    tier: "full",
    gis: "none",
    capture: z.object({ summary: z.string().trim().min(1, "Summarize what the survey found") }),
    slaHours: 336,
  }),
];
