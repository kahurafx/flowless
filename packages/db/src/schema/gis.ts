import {
  ASSET_CONDITIONS,
  GIS_ASSET_KINDS,
  JUNCTION_TYPES,
  MAIN_BRANCH,
  NODE_TYPES,
  PIPE_MATERIALS,
  STRUCTURE_TYPES,
} from "@flowless/shared-types";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { lineStringColumn, pointColumn, polygonColumn } from "../geometry";
import { tenantPolicy } from "../tenant";
import { organization } from "./auth";
import { area } from "./kernel";

/**
 * The GIS module (G-01 to G-03, K-02 map data), ported from Majimap. Network assets are
 * versioned per branch (branch-per-job editing): a row is one version of an entity, and
 * the branch `main` is the live network. Every foreign key between GIS tables includes
 * `organization_id`, so nothing can point across tenants.
 */
export const gis = pgSchema("gis");

export const nodeType = gis.enum("node_type", NODE_TYPES);
export const assetCondition = gis.enum("condition", ASSET_CONDITIONS);
export const structureType = gis.enum("structure_type", STRUCTURE_TYPES);
export const pipeMaterial = gis.enum("pipe_material", PIPE_MATERIALS);
export const junctionType = gis.enum("junction_type", JUNCTION_TYPES);

const organizationId = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organization.id);

/**
 * The stable identity of every versioned GIS asset (nodes, pipes, structures, service
 * connections), whichever version is current. Other tables reference "that valve" here.
 * Replaces Majimap's shared `public.assets`: it belongs to GIS alone, and other modules
 * reach GIS assets through the kernel work ports, never by key. Labels and locations live
 * on the versions, so nothing here goes stale.
 */
export const asset = gis.table(
  "asset",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    kind: text("kind", { enum: GIS_ASSET_KINDS }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").notNull(),
  },
  (t) => [
    unique("asset_organization_id_id_unique").on(t.organizationId, t.id),
    check("asset_kind_valid", sql`${t.kind} in ('node', 'pipe', 'structure', 'service_connection')`),
    tenantPolicy(t.organizationId),
  ],
);

/** A composite foreign key to `gis.asset`, so an asset reference never crosses tenants. */
const assetFk = (name: string, t: { organizationId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({ name, columns: [t.organizationId, column], foreignColumns: [asset.organizationId, asset.id] });

/**
 * Branch-versioned columns (Majimap's `versionedColumns`). A row is one version of the
 * asset `id`; `version_id` is the row's own key, the target when something belongs to one
 * specific edit. Only one row per (id, branch) is the head (partial unique index per table).
 * `is_deleted` makes the row a tombstone: a branch hides an entity by adding a version, never
 * by deleting a row. Editing inserts a new version and clears the old head's `is_head`.
 * `created_by_user_id` is history, so it has no foreign key to the membership.
 */
const versionedColumns = () => ({
  versionId: uuid("version_id").primaryKey().defaultRandom(),
  id: uuid("id").notNull(),
  organizationId: organizationId(),
  branch: text("branch").notNull().default(MAIN_BRANCH),
  isHead: boolean("is_head").notNull().default(true),
  isDeleted: boolean("is_deleted").notNull().default(false),
  supersedesVersionId: uuid("supersedes_version_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdByUserId: uuid("created_by_user_id").notNull(),
});

type Versioned = { organizationId: AnyPgColumn; id: AnyPgColumn; branch: AnyPgColumn; isHead: AnyPgColumn };

/** The constraints and indexes every versioned asset table has. */
const versioned = (name: string, t: Versioned) => [
  assetFk(`${name}_asset_fk`, t, t.id),
  uniqueIndex(`${name}_head_unique`).on(t.organizationId, t.id, t.branch).where(sql`${t.isHead} = true`),
  index(`${name}_branch_idx`).on(t.organizationId, t.branch),
  tenantPolicy(t.organizationId),
];

/**
 * Network tiers (transmission, distribution, DMA): configuration, not versioned, since
 * technicians do not edit them in the field.
 */
export const tier = gis.table(
  "tier",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    name: text("name").notNull(),
    order: integer("order").notNull(),
  },
  (t) => [
    unique("tier_organization_id_id_unique").on(t.organizationId, t.id),
    unique("tier_order_unique").on(t.organizationId, t.order),
    tenantPolicy(t.organizationId),
  ],
);

/** Vaults, chambers, manholes, kiosks and trenches that house nodes. */
export const structure = gis.table(
  "structure",
  {
    ...versionedColumns(),
    type: structureType("type").notNull(),
    name: text("name").notNull(),
    location: pointColumn("location").notNull(),
    condition: assetCondition("condition").notNull().default("unknown"),
    installedAt: timestamp("installed_at", { withTimezone: true }),
    lastInspectedAt: timestamp("last_inspected_at", { withTimezone: true }),
  },
  (t) => [...versioned("structure", t), index("structure_location_gist").using("gist", t.location)],
);

/**
 * Network nodes: reservoirs, pumping stations, valves, junctions, meters and hydrants. A
 * node may sit in a structure (`structure_id`, the structure's asset id) only if the
 * organization's attachment rules allow its type there, checked by the
 * `gis.check_structure_attachment` trigger (`0023_gis_structure_attachment.sql`).
 */
export const node = gis.table(
  "node",
  {
    ...versionedColumns(),
    type: nodeType("type").notNull(),
    name: text("name").notNull(),
    location: pointColumn("location").notNull(),
    condition: assetCondition("condition").notNull().default("unknown"),
    isOpen: boolean("is_open"),
    structureId: uuid("structure_id"),
    installedAt: timestamp("installed_at", { withTimezone: true }),
    lastInspectedAt: timestamp("last_inspected_at", { withTimezone: true }),
    // Junction details.
    junctionType: junctionType("junction_type"),
    mainSizeMm: integer("main_size_mm"),
    branchSizeMm: integer("branch_size_mm"),
  },
  (t) => [
    ...versioned("node", t),
    assetFk("node_structure_fk", t, t.structureId),
    index("node_structure_idx").on(t.organizationId, t.structureId),
    index("node_location_gist").using("gist", t.location),
    check(
      "node_junction_fields",
      sql`(${t.type} = 'junction' or (${t.junctionType} is null and ${t.mainSizeMm} is null and ${t.branchSizeMm} is null))
        and ((${t.junctionType} is null) = (${t.mainSizeMm} is null))
        and (${t.mainSizeMm} is null or ${t.mainSizeMm} > 0)
        and (${t.branchSizeMm} is null or (${t.mainSizeMm} is not null and ${t.branchSizeMm} < ${t.mainSizeMm}))
        and (${t.junctionType} is distinct from 'reducer' or ${t.branchSizeMm} is not null)`,
    ),
  ],
);

/** Pipes between two nodes (by asset id), with their drawn path. */
export const pipe = gis.table(
  "pipe",
  {
    ...versionedColumns(),
    fromNodeId: uuid("from_node_id").notNull(),
    toNodeId: uuid("to_node_id").notNull(),
    path: lineStringColumn("path").notNull(),
    material: pipeMaterial("material").notNull().default("unknown"),
    diameterMm: real("diameter_mm").notNull(),
    condition: assetCondition("condition").notNull().default("unknown"),
    /** Recorded length; may differ from the drawn path's. */
    lengthM: real("length_m").notNull(),
  },
  (t) => [
    ...versioned("pipe", t),
    assetFk("pipe_from_node_fk", t, t.fromNodeId),
    assetFk("pipe_to_node_fk", t, t.toNodeId),
    index("pipe_from_idx").on(t.organizationId, t.fromNodeId),
    index("pipe_to_idx").on(t.organizationId, t.toNodeId),
    index("pipe_path_gist").using("gist", t.path),
  ],
);

/**
 * Where a customer's supply leaves the network: a map feature, versioned and reviewed like
 * any other, but not part of the pipe graph. GIS holds no customers: `service_point_id` is
 * the Accounts service point, by id only (no foreign key across modules), null until
 * Accounts links one. `pipe_id` is the serving pipe's asset id, null until linked.
 */
export const serviceConnection = gis.table(
  "service_connection",
  {
    ...versionedColumns(),
    connectionNumber: text("connection_number").notNull(),
    location: pointColumn("location").notNull(),
    servicePointId: uuid("service_point_id"),
    pipeId: uuid("pipe_id"),
  },
  (t) => [
    ...versioned("service_connection", t),
    assetFk("service_connection_pipe_fk", t, t.pipeId),
    // Only what is live on main must be unique: a branch may propose a number, checked when posted.
    uniqueIndex("service_connection_number_unique")
      .on(t.organizationId, t.connectionNumber)
      .where(sql`${t.branch} = 'main' and ${t.isHead} = true and ${t.isDeleted} = false`),
    index("service_connection_service_point_idx").on(t.organizationId, t.servicePointId),
    index("service_connection_pipe_idx").on(t.organizationId, t.pipeId),
    index("service_connection_location_gist").using("gist", t.location),
  ],
);

/**
 * GIS map data for a DMA (K-02): the DMA itself is the kernel's `area` (level `dma`); this
 * table attaches its boundary, inlet meter and tier, versioned per branch like the network.
 * The logical key is (organization_id, area_id); one head per area and branch. The name
 * comes from the kernel area. `inlet_meter_id` is a meter node's asset id.
 */
export const dma = gis.table(
  "dma",
  {
    versionId: uuid("version_id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    areaId: uuid("area_id").notNull(),
    branch: text("branch").notNull().default(MAIN_BRANCH),
    isHead: boolean("is_head").notNull().default(true),
    isDeleted: boolean("is_deleted").notNull().default(false),
    supersedesVersionId: uuid("supersedes_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    color: text("color").notNull(),
    tierId: uuid("tier_id").notNull(),
    inletMeterId: uuid("inlet_meter_id"),
    boundary: polygonColumn("boundary").notNull(),
  },
  (t) => [
    unique("dma_organization_id_version_id_unique").on(t.organizationId, t.versionId),
    foreignKey({ name: "dma_area_fk", columns: [t.organizationId, t.areaId], foreignColumns: [area.organizationId, area.id] }),
    foreignKey({ name: "dma_tier_fk", columns: [t.organizationId, t.tierId], foreignColumns: [tier.organizationId, tier.id] }),
    assetFk("dma_inlet_meter_fk", t, t.inletMeterId),
    uniqueIndex("dma_head_unique").on(t.organizationId, t.areaId, t.branch).where(sql`${t.isHead} = true`),
    index("dma_branch_idx").on(t.organizationId, t.branch),
    index("dma_boundary_gist").using("gist", t.boundary),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * Boundary valves belong to one version of a DMA's map data (`dma_version_id`), so a
 * branch can propose a different set than main. Editing them means a new `dma` version
 * with a fresh set of rows, never changing an old version's rows.
 */
export const dmaBoundaryValve = gis.table(
  "dma_boundary_valve",
  {
    organizationId: organizationId(),
    dmaVersionId: uuid("dma_version_id").notNull(),
    valveId: uuid("valve_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.dmaVersionId, t.valveId] }),
    foreignKey({
      name: "dma_boundary_valve_dma_fk",
      columns: [t.organizationId, t.dmaVersionId],
      foreignColumns: [dma.organizationId, dma.versionId],
    }).onDelete("cascade"),
    assetFk("dma_boundary_valve_valve_fk", t, t.valveId),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * Subnetworks: configuration, not versioned. Membership is never stored; it is traced
 * live from `controller_node_id` (packages/network). `last_validated_at` records the last trace.
 */
export const subnetwork = gis.table(
  "subnetwork",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    name: text("name").notNull(),
    tierId: uuid("tier_id").notNull(),
    controllerNodeId: uuid("controller_node_id").notNull(),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({ name: "subnetwork_tier_fk", columns: [t.organizationId, t.tierId], foreignColumns: [tier.organizationId, tier.id] }),
    assetFk("subnetwork_controller_fk", t, t.controllerNodeId),
    tenantPolicy(t.organizationId),
  ],
);

/**
 * Which structure types each node type may be housed in, per organization (configuration,
 * NF-32), seeded from `STRUCTURE_ATTACHMENT_RULES` in shared-types. The
 * `gis.check_structure_attachment` trigger enforces it, however a row is written.
 */
export const structureAttachmentRule = gis.table(
  "structure_attachment_rule",
  {
    organizationId: organizationId(),
    nodeType: nodeType("node_type").notNull(),
    structureType: structureType("structure_type").notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.nodeType, t.structureType] }), tenantPolicy(t.organizationId)],
);

/*
 * Inspection and valve-operation logs: facts, not versioned, append-only for the app role
 * (`0021_gis_access.sql`). Ids are client-minted, so an offline device can retry a sync
 * without duplicates. Two times: when it happened on the device, and when the server got it.
 * `branch` is the branch the work was on (a job's branch for job logs); discarding a
 * branch discards edits, not the inspection that prompted them.
 */

/** The condition of a node, pipe or structure, as someone found it. */
export const conditionLog = gis.table(
  "condition_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    assetId: uuid("asset_id").notNull(),
    branch: text("branch").notNull().default(MAIN_BRANCH),
    condition: assetCondition("condition").notNull(),
    note: text("note"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    recordedByUserId: uuid("recorded_by_user_id").notNull(),
  },
  (t) => [
    assetFk("condition_log_asset_fk", t, t.assetId),
    index("condition_log_asset_idx").on(t.organizationId, t.assetId, t.recordedAt),
    index("condition_log_recorded_idx").on(t.organizationId, t.recordedAt),
    tenantPolicy(t.organizationId),
  ],
);

/** A valve opened or closed. */
export const valveStateLog = gis.table(
  "valve_state_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: organizationId(),
    valveId: uuid("valve_id").notNull(),
    branch: text("branch").notNull().default(MAIN_BRANCH),
    isOpen: boolean("is_open").notNull(),
    note: text("note"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    changedByUserId: uuid("changed_by_user_id").notNull(),
  },
  (t) => [
    assetFk("valve_state_log_valve_fk", t, t.valveId),
    index("valve_state_log_valve_idx").on(t.organizationId, t.valveId, t.changedAt),
    tenantPolicy(t.organizationId),
  ],
);
