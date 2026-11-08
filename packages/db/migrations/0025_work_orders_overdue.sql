-- Custom: the worker's one cross-tenant read for work-order SLA breaches (W-02, X-02), like
-- kernel.overdue_approvals. Returns open jobs past their due time whose breach has not been
-- raised yet, only for organizations licensed for Work Orders (SLA is a full-level feature,
-- and an unlicensed tenant's jobs must not fill the batch). Raising the exception and
-- stamping overdue_at then happen inside withTenant.

CREATE FUNCTION "work_orders"."overdue_work_orders"(batch integer)
RETURNS TABLE(id uuid, organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT w.id, w.organization_id FROM work_orders.work_order AS w
   WHERE w.status NOT IN ('completed', 'cancelled')
     AND w.overdue_at IS NULL
     AND w.due_at <= clock_timestamp()
     AND EXISTS (
       SELECT 1 FROM kernel.organization_module AS m
        WHERE m.organization_id = w.organization_id AND m.module = 'work-orders'
     )
   ORDER BY w.due_at, w.id
   LIMIT batch
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "work_orders"."overdue_work_orders"(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "work_orders"."overdue_work_orders"(integer) TO "flowless_app";
