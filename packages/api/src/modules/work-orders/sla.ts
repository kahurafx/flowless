import { withTenant, type Database } from "@flowless/db";
import { workOrder } from "@flowless/db/schema/work-orders";
import { and, eq, isNull, lte, notInArray, sql } from "drizzle-orm";
import { raiseException } from "../../kernel/exception-store";
import { overdueKey } from "./store";

/**
 * The SLA sweep (W-02, X-02), run by `apps/worker` once a minute. Open jobs past their due
 * time, in organizations licensed for Work Orders, go to the exception queue once each
 * (owner: the assignee, placed in the job's area and route so scoped members see it). The
 * breach is resolved when the job completes or is cancelled, or when it is rescheduled into
 * the future (which lets it be raised again later). Returns how many were raised.
 */
export async function sweepOverdueWorkOrders(db: Database, { batch = 50 }: { batch?: number } = {}): Promise<number> {
  const due = await db.execute<{ id: string; organization_id: string }>(sql`select * from work_orders.overdue_work_orders(${batch})`);
  let raised = 0;
  for (const { id, organization_id: organizationId } of due) {
    await withTenant(db, organizationId, async (tx) => {
      const [row] = await tx
        .update(workOrder)
        .set({ overdueAt: new Date() })
        .where(
          and(
            eq(workOrder.id, id),
            isNull(workOrder.overdueAt),
            notInArray(workOrder.status, ["completed", "cancelled"]),
            lte(workOrder.dueAt, sql`clock_timestamp()`),
          ),
        )
        .returning();
      if (!row) return;
      await raiseException(tx, organizationId, {
        type: "WORK_ORDER_OVERDUE",
        source: "work-orders",
        title: `Work order overdue: ${row.code} ${row.title}`,
        detail: `Due ${row.dueAt.toISOString()}, still ${row.status.replace("_", " ")}.`,
        subject: { kind: "work_order", ref: row.id },
        areaId: row.areaId,
        routeId: row.routeId,
        ownerUserId: row.assignedToUserId,
        dedupeKey: overdueKey(row.id),
      });
      raised += 1;
    });
  }
  return raised;
}
