import { area, route, type Transaction } from "@flowless/db";
import type { AreaLevel } from "@flowless/shared-types";
import { inArray } from "drizzle-orm";

export interface AreaInfo {
  id: string;
  level: AreaLevel;
  code: string;
  name: string;
  parentId: string | null;
  archivedAt: Date | null;
}

export interface RouteInfo {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  areaId: string | null;
  archivedAt: Date | null;
}

/**
 * The kernel hierarchy's published read for modules (K-02): areas by id, in the caller's
 * organization (RLS). GIS uses it to check that a DMA's map data sits on an area of level
 * "dma" and to name it, Accounts to check a service point's scheme, zone and DMA, without
 * reading kernel tables themselves.
 */
export async function areasById(tx: Transaction, ids: readonly string[]): Promise<Map<string, AreaInfo>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: area.id, level: area.level, code: area.code, name: area.name, parentId: area.parentId, archivedAt: area.archivedAt })
    .from(area)
    .where(inArray(area.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Routes by id, in the caller's organization (RLS): the published read Accounts checks a service point's route with. */
export async function routesById(tx: Transaction, ids: readonly string[]): Promise<Map<string, RouteInfo>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: route.id, code: route.code, name: route.name, parentId: route.parentId, areaId: route.areaId, archivedAt: route.archivedAt })
    .from(route)
    .where(inArray(route.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}
