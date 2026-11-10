-- Custom: guarantees for the tables of 0040 (M-06, M-08, M-09, C-08, C-10). The grants of
-- 0039 already cover new tables through default privileges; these tables are insert-only.

REVOKE UPDATE, DELETE, TRUNCATE ON "metering"."read_attempt" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "metering"."eligibility_snapshot" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "metering"."eligibility_row" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "metering"."reading_handover" FROM "flowless_app";--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "metering"."handover_closing" FROM "flowless_app";
