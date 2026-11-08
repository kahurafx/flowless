/**
 * The GIS network model (G-01), ported from Majimap. These lists back the `gis` Postgres
 * enums in packages/db, so adding a value needs a migration there.
 */
export const NODE_TYPES = ["reservoir", "pumping_station", "valve", "junction", "meter", "hydrant"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const ASSET_CONDITIONS = ["good", "fair", "poor", "critical", "unknown"] as const;
export type AssetCondition = (typeof ASSET_CONDITIONS)[number];

export const STRUCTURE_TYPES = ["vault", "chamber", "manhole", "kiosk", "trench"] as const;
export type StructureType = (typeof STRUCTURE_TYPES)[number];

export const PIPE_MATERIALS = ["pvc", "ductile_iron", "hdpe", "steel", "concrete", "unknown"] as const;
export type PipeMaterial = (typeof PIPE_MATERIALS)[number];

export const JUNCTION_TYPES = ["tee", "cross", "elbow", "wye", "reducer"] as const;
export type JunctionType = (typeof JUNCTION_TYPES)[number];

/** What a `gis.asset` row (the stable identity behind every version) is. */
export const GIS_ASSET_KINDS = ["node", "pipe", "structure", "service_connection"] as const;
export type GisAssetKind = (typeof GIS_ASSET_KINDS)[number];

/** The live network. Every other branch is a proposal until it is posted. */
export const MAIN_BRANCH = "main";

/**
 * Default structure types each node type may be housed in. An organization's rules live in
 * `gis.structure_attachment_rule` (seeded from these when GIS is set up) and a trigger
 * enforces them; this constant is the client-side pre-check and the seed.
 */
export const STRUCTURE_ATTACHMENT_RULES: Record<NodeType, readonly StructureType[]> = {
  reservoir: [],
  pumping_station: [],
  valve: ["vault", "chamber", "manhole"],
  junction: ["manhole"],
  meter: ["chamber", "kiosk", "manhole"],
  hydrant: [],
};
