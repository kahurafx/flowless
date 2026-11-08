import { workOrder, workOrderChangeSet } from "@flowless/db/schema/work-orders";
import { and, eq, inArray } from "drizzle-orm";
import type { BranchAnnotator, BranchOrigin } from "../../../kernel/work";
import { WORK_ORDER_BRANCH_PREFIX } from "./branch-guard";

/** Tells the reconcile screen which job a "wo-…" branch belongs to, and how that job is going. */
export const workOrderBranchAnnotator: BranchAnnotator = {
  prefix: WORK_ORDER_BRANCH_PREFIX,
  async annotate(tx, branches) {
    const found = new Map<string, BranchOrigin>();
    if (branches.length === 0) return found;
    const rows = await tx
      .select({ branch: workOrderChangeSet.branch, id: workOrder.id, code: workOrder.code, title: workOrder.title, status: workOrder.status })
      .from(workOrderChangeSet)
      .innerJoin(workOrder, and(eq(workOrder.organizationId, workOrderChangeSet.organizationId), eq(workOrder.id, workOrderChangeSet.workOrderId)))
      .where(inArray(workOrderChangeSet.branch, [...branches]));
    for (const row of rows) found.set(row.branch, { kind: "work_order", ref: row.code, id: row.id, title: row.title, status: row.status });
    return found;
  },
};
