-- Custom: grants for the `gis` schema (G-01), copied from the kernel block of
-- 0001_schema_access.sql. Only flowless_app reaches it; flowless_auth gets nothing here.

GRANT USAGE ON SCHEMA "gis" TO "flowless_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "gis" TO "flowless_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "gis" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "flowless_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "gis" GRANT USAGE, SELECT ON SEQUENCES TO "flowless_app";--> statement-breakpoint

-- Condition and valve logs are facts, not proposals: append-only (Majimap kept them so too).
REVOKE UPDATE, DELETE, TRUNCATE ON "gis"."condition_log" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "gis"."valve_state_log" FROM "flowless_app";
