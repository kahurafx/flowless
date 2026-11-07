-- Custom: drizzle-kit cannot express grants. Each schema states exactly which runtime role
-- may use it, so flowless_app reaches only module schemas and flowless_auth only `auth`
-- (docs/build-plan.md, boundary rules). A new module schema copies the kernel block.
-- Append-only tables then REVOKE UPDATE, DELETE in their own migration (NF-22).

GRANT USAGE ON SCHEMA "kernel" TO "flowless_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "kernel" TO "flowless_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "kernel" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "flowless_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "kernel" GRANT USAGE, SELECT ON SEQUENCES TO "flowless_app";--> statement-breakpoint

GRANT USAGE ON SCHEMA "auth" TO "flowless_auth";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "auth" TO "flowless_auth";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "auth" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "flowless_auth";
