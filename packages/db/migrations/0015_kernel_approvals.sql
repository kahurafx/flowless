CREATE TABLE "kernel"."approval_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"decision" text NOT NULL,
	"by_user_id" uuid NOT NULL,
	"note" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_decision_valid" CHECK ("kernel"."approval_decision"."decision" in ('approve', 'reject', 'cancel'))
);
--> statement-breakpoint
ALTER TABLE "kernel"."approval_decision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kernel"."approval_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_ref" text NOT NULL,
	"title" text NOT NULL,
	"amount" bigint,
	"reason_code" text,
	"note" text DEFAULT '' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"area_id" uuid,
	"route_id" uuid,
	"requested_by_user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "approval_request_organization_id" UNIQUE("organization_id","id"),
	CONSTRAINT "approval_request_status_valid" CHECK ("kernel"."approval_request"."status" in ('pending', 'approved', 'rejected', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "kernel"."approval_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kernel"."approval_decision" ADD CONSTRAINT "approval_decision_request_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "kernel"."approval_request"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."approval_request" ADD CONSTRAINT "approval_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."approval_request" ADD CONSTRAINT "approval_request_area_fk" FOREIGN KEY ("organization_id","area_id") REFERENCES "kernel"."area"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."approval_request" ADD CONSTRAINT "approval_request_route_fk" FOREIGN KEY ("organization_id","route_id") REFERENCES "kernel"."route"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_decision_request_idx" ON "kernel"."approval_decision" USING btree ("organization_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_request_one_pending" ON "kernel"."approval_request" USING btree ("organization_id","kind","subject_ref") WHERE "kernel"."approval_request"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approval_request_status_idx" ON "kernel"."approval_request" USING btree ("organization_id","status","requested_at");--> statement-breakpoint
CREATE INDEX "approval_request_due_idx" ON "kernel"."approval_request" USING btree ("due_at") WHERE "kernel"."approval_request"."status" = 'pending' and "kernel"."approval_request"."escalated_at" is null;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kernel"."approval_decision" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("kernel"."approval_decision"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("kernel"."approval_decision"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "kernel"."approval_request" AS PERMISSIVE FOR ALL TO "flowless_app" USING ("kernel"."approval_request"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("kernel"."approval_request"."organization_id" = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
-- Custom: decisions are history (K-05, K-06).
REVOKE UPDATE, DELETE, TRUNCATE ON "kernel"."approval_decision" FROM "flowless_app";--> statement-breakpoint

-- Like kernel.claim_jobs: the worker's one cross-tenant read for approvals. Returns pending
-- requests whose current level is past its SLA and not yet escalated; escalating them then
-- happens inside withTenant.
CREATE FUNCTION "kernel"."overdue_approvals"(batch integer)
RETURNS TABLE(id uuid, organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT r.id, r.organization_id FROM kernel.approval_request AS r
   WHERE r.status = 'pending' AND r.escalated_at IS NULL AND r.due_at <= clock_timestamp()
   ORDER BY r.due_at, r.id
   LIMIT batch
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "kernel"."overdue_approvals"(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "kernel"."overdue_approvals"(integer) TO "flowless_app";
