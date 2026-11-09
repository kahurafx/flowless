-- Custom: grants for the `accounts` schema (C-01, C-02), copied from the kernel block of
-- 0001_schema_access.sql. Only flowless_app reaches it; flowless_auth gets nothing here.

GRANT USAGE ON SCHEMA "accounts" TO "flowless_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "accounts" TO "flowless_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "accounts" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "flowless_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "accounts" GRANT USAGE, SELECT ON SEQUENCES TO "flowless_app";--> statement-breakpoint

-- Customers, accounts and service points are never deleted: their history is the audit log
-- (and, later, the ledger), and a number once issued is never reused. The counter only moves
-- forward. A contact can be removed (audited), but the table is never truncated.
REVOKE DELETE, TRUNCATE ON "accounts"."customer" FROM "flowless_app";--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "accounts"."account" FROM "flowless_app";--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "accounts"."service_point" FROM "flowless_app";--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "accounts"."account_counter" FROM "flowless_app";--> statement-breakpoint
REVOKE TRUNCATE ON "accounts"."customer_contact" FROM "flowless_app";
