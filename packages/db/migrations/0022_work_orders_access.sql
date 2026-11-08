-- Custom: grants for the `work_orders` schema (W-01), copied from the kernel block of
-- 0001_schema_access.sql. Only flowless_app reaches it; flowless_auth gets nothing here.

GRANT USAGE ON SCHEMA "work_orders" TO "flowless_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "work_orders" TO "flowless_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "work_orders" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "flowless_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "work_orders" GRANT USAGE, SELECT ON SEQUENCES TO "flowless_app";--> statement-breakpoint

-- A job's history is append-only: its events (Majimap's audit trail of every action, kept
-- even when rejected), the branch it was given, the logs linked to it, its comments and its
-- captures. Corrections are new rows.
REVOKE UPDATE, DELETE, TRUNCATE ON "work_orders"."work_order_event" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "work_orders"."work_order_change_set" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "work_orders"."work_order_log_link" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "work_orders"."work_order_comment" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "work_orders"."work_order_capture" FROM "flowless_app";--> statement-breakpoint

-- The assignee must be a member of the job's organization. When they leave, the job stays
-- and becomes unassigned: SET NULL on assigned_to_user_id only, which drizzle-kit cannot
-- express (like kernel.exception's owner, 0013_kernel_exception_owner.sql).
ALTER TABLE "work_orders"."work_order" ADD CONSTRAINT "work_order_assignee_fk"
  FOREIGN KEY ("organization_id", "assigned_to_user_id") REFERENCES "auth"."member"("organization_id", "user_id")
  ON DELETE SET NULL ("assigned_to_user_id");
