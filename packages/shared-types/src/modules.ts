/** Licensable modules, by folder name (docs/build-plan.md, Code layout; requirements §3). The kernel is always on. */
export const MODULE_KEYS = [
  "accounts",
  "tariffs",
  "metering",
  "billing",
  "payments",
  "communications",
  "collections",
  "work-orders",
  "inventory",
  "gis",
  "nrw",
  "portal",
  "reporting",
  "migration",
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

/** The modules an organization is licensed for (K-04). Navigation is built from this. */
export type Entitlements = readonly ModuleKey[];

export function isModuleKey(value: string): value is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(value);
}

/**
 * Modules that cannot work without another. Everything else degrades gracefully when a
 * module is absent (requirements §3), so this list stays short: only hard data needs.
 */
export const MODULE_REQUIRES: Partial<Record<ModuleKey, readonly ModuleKey[]>> = {
  tariffs: ["accounts"],
  metering: ["accounts"],
  billing: ["accounts", "tariffs"],
  payments: ["accounts"],
  collections: ["accounts", "billing"],
  portal: ["accounts"],
  nrw: ["gis", "metering"],
};

/** Why this set of modules cannot be licensed together, or null when it can. */
export function entitlementProblem(modules: Entitlements): string | null {
  const on = new Set(modules);
  for (const module of on) {
    const missing = (MODULE_REQUIRES[module] ?? []).filter((m) => !on.has(m));
    if (missing.length) return `${module} needs ${missing.join(" and ")}`;
  }
  return null;
}
