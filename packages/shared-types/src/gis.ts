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

/** Whether a new node of a type must have a photo before it can go live (posted to main). */
export type PhotoRule = "required" | "optional";

/**
 * Required where the asset is above ground and worth proving (ported from Majimap). The
 * server enforces it when a branch is posted; clients use it to prompt for the photo.
 */
export const NODE_PHOTO_RULE: Record<NodeType, PhotoRule> = {
  reservoir: "required",
  pumping_station: "required",
  meter: "required",
  valve: "optional",
  hydrant: "optional",
  junction: "optional",
};

/** A proposed asset this close (metres) to a registered one of the same type is flagged as a possible duplicate. */
export const DUPLICATE_RADIUS_M = 15;

/**
 * A member's personal branch for edits made outside a job: `fld-<userId>`. Only its owner
 * (and members who may post to main) write to it; posting it needs `gis:post`.
 */
export const PERSONAL_BRANCH_PREFIX = "fld-";
export const personalBranch = (userId: string) => `${PERSONAL_BRANCH_PREFIX}${userId.toLowerCase()}`;
