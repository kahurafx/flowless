import { char, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantPolicy } from "../tenant";
import { organization } from "./auth";

/** Kernel module tables (requirements §4.1). */
export const kernel = pgSchema("kernel");

/**
 * Per-organization locale settings (NF-33) and the currency all money is held in
 * (B-18). One row per tenant; the organization itself is Better Auth's
 * `auth.organization`, which only packages/auth reads.
 */
export const organizationSettings = kernel.table(
  "organization_settings",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organization.id),
    currency: char("currency", { length: 3 }).notNull(),
    timeZone: text("time_zone").notNull(),
    locale: text("locale").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [tenantPolicy(t.organizationId)],
);
