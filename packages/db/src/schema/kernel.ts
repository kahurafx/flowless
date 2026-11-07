import { AREA_LEVELS } from "@flowless/shared-types";
import { type AnyPgColumn, char, foreignKey, index, pgSchema, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
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

export const areaLevel = kernel.enum("area_level", AREA_LEVELS);

/**
 * The organization hierarchy (K-02): schemes, zones, sub-zones and DMAs in one tree.
 * A parent sits at a higher level (checked by the hierarchy service, `areaParentProblem`).
 * Foreign keys include `organization_id`, so a tree never crosses tenants. Areas are
 * archived, never deleted, because accounts and readings will reference them.
 * GIS adds map data (boundary, inlet meter) to DMA ids in Phase 2.
 */
export const area = kernel.table(
  "area",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    level: areaLevel("level").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    parentId: uuid("parent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    unique("area_organization_id_id_unique").on(t.organizationId, t.id),
    unique("area_code_unique").on(t.organizationId, t.level, t.code),
    foreignKey({ name: "area_parent_fk", columns: [t.organizationId, t.parentId], foreignColumns: [t.organizationId, t.id] }),
    index("area_parent_idx").on(t.parentId),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * The operational route hierarchy (K-02), separate from areas: route groups and routes.
 * Service points join routes in the Accounts module; `area_id` only groups a route.
 */
export const route = kernel.table(
  "route",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    parentId: uuid("parent_id"),
    areaId: uuid("area_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    unique("route_organization_id_id_unique").on(t.organizationId, t.id),
    unique("route_code_unique").on(t.organizationId, t.code),
    foreignKey({ name: "route_parent_fk", columns: [t.organizationId, t.parentId], foreignColumns: [t.organizationId, t.id] }),
    foreignKey({ name: "route_area_fk", columns: [t.organizationId, t.areaId], foreignColumns: [area.organizationId, area.id] }),
    index("route_parent_idx").on(t.parentId),
    tenantPolicy(t.organizationId),
  ],
);

const memberFk = (name: string, t: { organizationId: AnyPgColumn; userId: AnyPgColumn }) =>
  foreignKey({ name, columns: [t.organizationId, t.userId], foreignColumns: [member.organizationId, member.userId] }).onDelete(
    "cascade",
  );

/**
 * Scope restrictions (K-03): the areas a member is limited to, each including everything
 * below it. A member with no area and no route rows is unrestricted.
 */
export const memberAreaScope = kernel.table(
  "member_area_scope",
  {
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    areaId: uuid("area_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId, t.areaId] }),
    memberFk("member_area_scope_member_fk", t),
    foreignKey({
      name: "member_area_scope_area_fk",
      columns: [t.organizationId, t.areaId],
      foreignColumns: [area.organizationId, area.id],
    }).onDelete("cascade"),
    tenantPolicy(t.organizationId),
  ],
);

/** Scope restrictions (K-03): the routes a member is limited to, with their sub-routes. */
export const memberRouteScope = kernel.table(
  "member_route_scope",
  {
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    routeId: uuid("route_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId, t.routeId] }),
    memberFk("member_route_scope_member_fk", t),
    foreignKey({
      name: "member_route_scope_route_fk",
      columns: [t.organizationId, t.routeId],
      foreignColumns: [route.organizationId, route.id],
    }).onDelete("cascade"),
    tenantPolicy(t.organizationId),
  ],
);
