/**
 * Organization hierarchy (K-02): scheme, zone, sub-zone and DMA, highest first. An
 * organization uses the levels it needs: a parent only has to sit at a higher level, so
 * a DMA may hang off a zone directly when there are no sub-zones.
 * Routes are a separate operational hierarchy (route groups and routes).
 */
export const AREA_LEVELS = ["scheme", "zone", "sub_zone", "dma"] as const;
export type AreaLevel = (typeof AREA_LEVELS)[number];

export const areaLevelLabel: Record<AreaLevel, string> = {
  scheme: "Scheme",
  zone: "Zone",
  sub_zone: "Sub-zone",
  dma: "DMA",
};

/** Why `level` cannot sit under `parentLevel`, or null when it can. Schemes are top-level. */
export function areaParentProblem(level: AreaLevel, parentLevel: AreaLevel | null): string | null {
  if (level === "scheme") return parentLevel ? "A scheme has no parent" : null;
  if (!parentLevel) return `A ${areaLevelLabel[level].toLowerCase()} needs a parent`;
  return AREA_LEVELS.indexOf(parentLevel) < AREA_LEVELS.indexOf(level)
    ? null
    : `A ${areaLevelLabel[level].toLowerCase()} must sit under a higher level than ${areaLevelLabel[parentLevel].toLowerCase()}`;
}

export interface Area {
  id: string;
  level: AreaLevel;
  code: string;
  name: string;
  parentId: string | null;
  archivedAt: Date | null;
}

export interface Route {
  id: string;
  code: string;
  name: string;
  /** A route group this route belongs to. */
  parentId: string | null;
  /** The area the route mostly serves, for grouping. Optional. */
  areaId: string | null;
  archivedAt: Date | null;
}

/**
 * What part of the organization a member may see (K-03). `all` unless the member has
 * scope restrictions; `limited` lists the areas and routes they cover, each including
 * everything below it.
 */
export type Scope =
  | { kind: "all" }
  | { kind: "limited"; areaIds: ReadonlySet<string>; routeIds: ReadonlySet<string> };

/**
 * True when the scope covers a record placed at `areaId` and/or `routeId`. A limited
 * member sees a record if either its area or its route is theirs; records with neither
 * are organization-wide and visible only to unrestricted members.
 */
export function scopeCovers(scope: Scope, place: { areaId?: string | null; routeId?: string | null }): boolean {
  if (scope.kind === "all") return true;
  return (!!place.areaId && scope.areaIds.has(place.areaId)) || (!!place.routeId && scope.routeIds.has(place.routeId));
}
