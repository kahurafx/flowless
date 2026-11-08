import { workOrder, workOrderChangeSet } from "@flowless/db/schema/work-orders";
import type { Permission, WorkOrderStatus } from "@flowless/shared-types";
import { and, eq } from "drizzle-orm";
import type { BranchGuard, BranchVerdict } from "../../../kernel/work";

/** Branches named "wo-…" belong to work orders. Lower-case; the kernel matches case-insensitively. */
export const WORK_ORDER_BRANCH_PREFIX = "wo-";

const deny = (reason: string): BranchVerdict => ({ allowed: false, reason });

/**
 * Who may write to a job's branch, once the branch is known to belong to a job (ported from
 * Majimap, with permissions for roles). The assignee while the job is being worked; a
 * manager (`work_orders:assign`) at any point before it's finished, so a supervisor can fix
 * something while reviewing. Nobody once it's completed or cancelled. Pure.
 */
export function decideBranchWrite(
  job: { status: WorkOrderStatus; assignedToUserId: string | null },
  who: { userId: string; permissions: ReadonlySet<Permission> },
): BranchVerdict {
  if (job.status === "completed" || job.status === "cancelled") return deny(`This job is ${job.status}`);
  if (who.permissions.has("work_orders:assign")) return { allowed: true };
  if (job.assignedToUserId !== who.userId) return deny("This job is assigned to someone else");
  if (job.status !== "in_progress") return deny("Start the job before editing the network for it");
  return { allowed: true };
}

/**
 * Guards branches named "wo-…". The branch must belong to a job in the caller's
 * organization (RLS), matched EXACTLY (so "WO-1042" never reaches job wo-1042); otherwise
 * the write is refused: a work-order-looking branch nobody owns is somebody guessing.
 */
export const workOrderBranchGuard: BranchGuard = {
  prefix: WORK_ORDER_BRANCH_PREFIX,
  async check(tx, write) {
    const [job] = await tx
      .select({ status: workOrder.status, assignedToUserId: workOrder.assignedToUserId })
      .from(workOrderChangeSet)
      .innerJoin(workOrder, and(eq(workOrder.organizationId, workOrderChangeSet.organizationId), eq(workOrder.id, workOrderChangeSet.workOrderId)))
      .where(eq(workOrderChangeSet.branch, write.branch))
      .limit(1);
    if (!job) return deny("No work order owns that branch");
    return decideBranchWrite(job, write);
  },
};
