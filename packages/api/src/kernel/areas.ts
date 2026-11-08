import { area, type Transaction } from "@flowless/db";
import type { AreaLevel } from "@flowless/shared-types";
import { inArray } from "drizzle-orm";

export interface AreaInfo {
  id: string;
  level: AreaLevel;
  code: string;
  name: string;
  archivedAt: Date | null;
}

/**
 * The kernel hierarchy's published read for modules (K-02): areas by id, in the caller's
 * organization (RLS). GIS uses it to check that a DMA's map data sits on an area of level
 * "dma" and to name it, without reading kernel tables itself.
 */
export async function areasById(tx: Transaction, ids: readonly string[]): Promise<Map<string, AreaInfo>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: area.id, level: area.level, code: area.code, name: area.name, archivedAt: area.archivedAt })
    .from(area)
    .where(inArray(area.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}
