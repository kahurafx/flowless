import type { WorkOrderEffects } from "../../../kernel/work";
import { emit, gisBranchCancelled, gisBranchReady, gisBranchSubmitted } from "../events";

/**
 * What GIS does when a job that has a branch moves (ported from Majimap's link/effects.ts):
 * tell the outbox, in the same transaction, so engineers have a feed of branches waiting
 * for them. It does NOT post anything: approving the work and posting the data stay two
 * decisions by two people. A cancelled job's branch is announced too: posting it is
 * refused from then on (the "wo-" annotator reports it cancelled), so it can only be
 * discarded. Jobs with no branch have nothing GIS cares about.
 */
export const gisWorkOrderEffects: WorkOrderEffects = {
  module: "gis",
  async onSubmit(tx, event) {
    if (!event.branch) return;
    await emit(tx, event.organizationId, gisBranchSubmitted, { branch: event.branch, workOrderId: event.workOrderId, actorUserId: event.actorUserId });
  },
  async onApprove(tx, event) {
    if (!event.branch) return;
    await emit(tx, event.organizationId, gisBranchReady, { branch: event.branch, workOrderId: event.workOrderId, actorUserId: event.actorUserId });
  },
  async onCancel(tx, event) {
    if (!event.branch) return;
    await emit(tx, event.organizationId, gisBranchCancelled, { branch: event.branch, workOrderId: event.workOrderId, actorUserId: event.actorUserId });
  },
};
