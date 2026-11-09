-- Custom: grants for the `tariffs` schema (T-01 to T-03, T-07 to T-10), copied from the kernel
-- block of 0001_schema_access.sql. Only flowless_app reaches it; flowless_auth gets nothing here.

GRANT USAGE ON SCHEMA "tariffs" TO "flowless_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "tariffs" TO "flowless_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "tariffs" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "flowless_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "tariffs" GRANT USAGE, SELECT ON SEQUENCES TO "flowless_app";--> statement-breakpoint

-- Versions are immutable (T-01, T-04): a tariff, a charge amount or a category's pricing
-- changes by inserting a new row, never by updating or deleting one, because issued
-- invoices cite the version they were priced with.
REVOKE UPDATE, DELETE, TRUNCATE ON "tariffs"."tariff_version" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "tariffs"."tariff_version_line" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "tariffs"."charge_item_amount" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "tariffs"."category_assignment" FROM "flowless_app";--> statement-breakpoint

-- Identities are deactivated, never deleted (accounts, invoices and the audit log point at
-- them), and an invoice number counter only moves forward.
REVOKE DELETE, TRUNCATE ON "tariffs"."category" FROM "flowless_app";--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "tariffs"."tariff" FROM "flowless_app";--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "tariffs"."charge_item" FROM "flowless_app";--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "tariffs"."invoice_type" FROM "flowless_app";--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "tariffs"."invoice_type_counter" FROM "flowless_app";--> statement-breakpoint

-- An invoice type's line template and late-fee rule are configuration, replaced as a whole
-- (audited with before and after); the tables are never truncated.
REVOKE TRUNCATE ON "tariffs"."invoice_type_line" FROM "flowless_app";--> statement-breakpoint
REVOKE TRUNCATE ON "tariffs"."late_fee_rule" FROM "flowless_app";
