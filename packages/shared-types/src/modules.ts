/** Module folder names (docs/build-plan.md, Code layout; requirements §3). */
export type ModuleKey =
  | "accounts"
  | "tariffs"
  | "metering"
  | "billing"
  | "payments"
  | "communications"
  | "collections"
  | "work-orders"
  | "inventory"
  | "gis"
  | "nrw"
  | "portal"
  | "reporting"
  | "migration";

/** The modules an organization is licensed for (K-04). Navigation is built from this. */
export type Entitlements = readonly ModuleKey[];
