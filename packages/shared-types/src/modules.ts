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

/** Every module that needs `module`, directly or through another. */
export function dependentsOf(module: ModuleKey): ModuleKey[] {
  const out = new Set<ModuleKey>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of MODULE_KEYS) {
      const needs = MODULE_REQUIRES[candidate] ?? [];
      if (!out.has(candidate) && needs.some((n) => n === module || out.has(n))) {
        out.add(candidate);
        grew = true;
      }
    }
  }
  return MODULE_KEYS.filter((m) => out.has(m));
}

/** `module` plus everything it needs, directly or not. */
export function withRequirements(module: ModuleKey): ModuleKey[] {
  const out = new Set<ModuleKey>([module]);
  const queue: ModuleKey[] = [module];
  for (let next = queue.pop(); next; next = queue.pop()) {
    for (const need of MODULE_REQUIRES[next] ?? []) {
      if (!out.has(need)) {
        out.add(need);
        queue.push(need);
      }
    }
  }
  return MODULE_KEYS.filter((m) => out.has(m));
}

/**
 * The module combinations CI runs (NF-31). Every subset would be 2^14; these cover each
 * module being absent (with what needs it) and present on its own (with what it needs),
 * plus none and all. Every combination is licensable.
 */
export function moduleMatrix(): { name: string; modules: ModuleKey[] }[] {
  const combos = [
    { name: "kernel only", modules: [] as ModuleKey[] },
    { name: "everything", modules: [...MODULE_KEYS] },
    ...MODULE_KEYS.map((m) => {
      const gone = new Set([m, ...dependentsOf(m)]);
      return { name: `without ${m}`, modules: MODULE_KEYS.filter((k) => !gone.has(k)) };
    }),
    ...MODULE_KEYS.map((m) => ({ name: `only ${m}`, modules: withRequirements(m) })),
  ];
  const seen = new Set<string>();
  return combos.filter((c) => !seen.has(c.modules.join()) && seen.add(c.modules.join()));
}
