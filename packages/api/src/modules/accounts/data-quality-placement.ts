/*
 * The `zone_equals_route` rule (C-12), pure. The legacy statement is "zone equal to route";
 * Flowless reads it as route and zone data entered in the wrong field, which shows up two ways
 * in the kernel hierarchy (K-02):
 *  - the route has the same NAME as the service point's zone, scheme or DMA (case, spacing and
 *    punctuation ignored): the same text was typed in both fields;
 *  - the route is grouped under an area (`route.area_id`) that has nothing to do with the
 *    service point: it is not the point's most specific area (DMA, else zone, else scheme), not
 *    above it and not below it. A route with no area is never flagged by this test.
 * The kernel is read only through its published reads (`areasById`, `routesById`); this file
 * decides from what they returned.
 */

export interface PlacementKey {
  s: string | null;
  z: string | null;
  d: string | null;
  r: string | null;
}

export interface AreaFact {
  id: string;
  name: string;
  parentId: string | null;
}

export interface RouteFact {
  id: string;
  name: string;
  areaId: string | null;
}

export const placementKeyOf = (k: PlacementKey) => `${k.s ?? ""}|${k.z ?? ""}|${k.d ?? ""}|${k.r ?? ""}`;

/** A name for comparing: lower case, letters and digits only. */
export const nameKey = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** `id` and every area above it. */
function chain(areas: ReadonlyMap<string, AreaFact>, id: string): Set<string> {
  const out = new Set<string>();
  for (let current = areas.get(id), depth = 0; current && !out.has(current.id) && depth < 8; depth++) {
    out.add(current.id);
    current = current.parentId ? areas.get(current.parentId) : undefined;
  }
  if (out.size === 0) out.add(id);
  return out;
}

/** Why this placement looks like route and zone confused, or null when it looks fine. */
export function placementProblem(key: PlacementKey, areas: ReadonlyMap<string, AreaFact>, routes: ReadonlyMap<string, RouteFact>): string | null {
  const route = key.r ? routes.get(key.r) : undefined;
  if (!route) return null;
  const placed = [key.z, key.s, key.d].flatMap((id) => (id ? [areas.get(id)] : [])).filter((a): a is AreaFact => a !== undefined);
  const routeName = nameKey(route.name);
  if (routeName) {
    const same = placed.find((a) => nameKey(a.name) === routeName);
    if (same) return `The route "${route.name}" has the same name as the area "${same.name}".`;
  }
  // Compare with the most specific place the point has: the route's area must be that area, above it or below it.
  const specific = [key.d, key.z, key.s].map((id) => (id ? areas.get(id) : undefined)).find((a) => a !== undefined);
  if (route.areaId && specific) {
    const compatible = chain(areas, route.areaId).has(specific.id) || chain(areas, specific.id).has(route.areaId);
    if (!compatible) {
      const where = areas.get(route.areaId)?.name ?? "another area";
      return `The route "${route.name}" belongs to ${where}, which is not where this service point is (${placed.map((a) => a.name).join(", ")}).`;
    }
  }
  return null;
}
