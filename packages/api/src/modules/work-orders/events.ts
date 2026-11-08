import { WORK_ORDER_OUTCOMES, WORK_ORDER_STATUSES, WORK_PRIORITIES } from "@flowless/shared-types";
import { z } from "zod";
import { defineEvent } from "../../kernel/events";

/*
 * What Work Orders publishes on the kernel outbox (K-09), in place of Majimap's
 * domain_events. Other modules react to these without Work Orders knowing they exist.
 */

export const workOrderCreated = defineEvent(
  "work_order.created",
  z.object({
    workOrderId: z.uuid(),
    code: z.string(),
    kind: z.string(),
    priority: z.enum(WORK_PRIORITIES),
    assetModule: z.string().nullable(),
    assetId: z.uuid().nullable(),
    areaId: z.uuid().nullable(),
    routeId: z.uuid().nullable(),
    parentId: z.uuid().nullable(),
    assigneeId: z.uuid().nullable(),
    selfRaised: z.boolean(),
  }),
);

export const workOrderAssigned = defineEvent(
  "work_order.assigned",
  z.object({ workOrderId: z.uuid(), from: z.uuid().nullable(), to: z.uuid().nullable(), crewId: z.uuid().nullable() }),
);

/** Every status change, whatever caused it (an action, a first touch, a cancel). */
export const workOrderStatusChanged = defineEvent(
  "work_order.status_changed",
  z.object({
    workOrderId: z.uuid(),
    code: z.string(),
    kind: z.string(),
    from: z.enum(WORK_ORDER_STATUSES),
    to: z.enum(WORK_ORDER_STATUSES),
    /** The work-order event type that caused it. */
    cause: z.string(),
    actorUserId: z.uuid(),
  }),
);

/**
 * A job finished (W-03): completed, approved, or a parent finalized. `capture` is the
 * completion data in force (the kind's `capture` schema), or null. A kind's own
 * `completionEvent` is published with this same payload, so its schema reads this shape.
 */
export const workOrderCompletedSchema = z.object({
  workOrderId: z.uuid(),
  code: z.string(),
  kind: z.string(),
  outcome: z.enum(WORK_ORDER_OUTCOMES).nullable(),
  assetModule: z.string().nullable(),
  assetId: z.uuid().nullable(),
  areaId: z.uuid().nullable(),
  routeId: z.uuid().nullable(),
  completedByUserId: z.uuid().nullable(),
  approvedByUserId: z.uuid().nullable(),
  finalized: z.boolean(),
  capture: z.unknown().nullable(),
});
export type WorkOrderCompleted = z.infer<typeof workOrderCompletedSchema>;
export const workOrderCompleted = defineEvent("work_order.completed", workOrderCompletedSchema);
