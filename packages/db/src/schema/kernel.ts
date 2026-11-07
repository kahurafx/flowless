import { char, foreignKey, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantPolicy } from "../tenant";
import { member, organization } from "./auth";

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

/**
 * Extra permissions an administrator granted a member on top of their role's defaults
 * (K-03; catalogue in `@flowless/shared-types` permissions). One row per permission.
 * The foreign key to the membership deletes a member's grants when they leave.
 */
export const memberPermission = kernel.table(
  "member_permission",
  {
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    permission: text("permission").notNull(),
    grantedBy: uuid("granted_by").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId, t.permission] }),
    foreignKey({
      name: "member_permission_member_fk",
      columns: [t.organizationId, t.userId],
      foreignColumns: [member.organizationId, member.userId],
    }).onDelete("cascade"),
    tenantPolicy(t.organizationId),
  ],
);
