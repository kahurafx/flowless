import type { Transaction } from "@flowless/db";
import { TRPCError } from "@trpc/server";
import { areasById, routesById } from "../../kernel/areas";
import { placementInScope, type Placement, type Viewer } from "./access";

/*
 * Where a service point (or an enquiry) sits: checked against the kernel's area and route
 * hierarchy (K-02) through its published reads, and against the viewer's scope.
 */

const AREA_LEVELS_FOR = {
  schemeId: ["scheme"],
  zoneId: ["zone", "sub_zone"],
  dmaId: ["dma"],
} as const;

const AREA_LABEL = { schemeId: "scheme", zoneId: "zone", dmaId: "DMA" } as const;

/** The areas above `areaId`, nearest first (at most four levels exist). */
async function ancestorsOf(tx: Transaction, areaId: string): Promise<Set<string>> {
  const out = new Set<string>();
  let current = (await areasById(tx, [areaId])).get(areaId);
  for (let depth = 0; current?.parentId && depth < 5; depth++) {
    out.add(current.parentId);
    current = (await areasById(tx, [current.parentId])).get(current.parentId);
  }
  return out;
}

/**
 * Checks a service point's place against the kernel hierarchy (K-02), through the kernel's
 * published reads: each area exists here and has the right level, the route exists, and the
 * areas sit on one branch (the DMA under the zone, the zone under the scheme). Only values
 * in `changed` are checked for being archived, so an old point stays editable when its area
 * is archived later.
 */
export async function validatePlacement(tx: Transaction, place: Placement, changed: ReadonlySet<keyof Placement>): Promise<void> {
  const areaKeys = ["schemeId", "zoneId", "dmaId"] as const;
  const areas = await areasById(
    tx,
    areaKeys.flatMap((k) => (place[k] ? [place[k]] : [])),
  );
  for (const key of areaKeys) {
    const id = place[key];
    if (!id) continue;
    const found = areas.get(id);
    if (!found) throw new TRPCError({ code: "NOT_FOUND", message: `The ${AREA_LABEL[key]} was not found` });
    if (!(AREA_LEVELS_FOR[key] as readonly string[]).includes(found.level)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `${found.name} is a ${found.level.replace("_", " ")}, not a ${AREA_LABEL[key]}` });
    }
    if (found.archivedAt && changed.has(key)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${found.name} is archived` });
  }
  if (place.dmaId && place.zoneId && !(await ancestorsOf(tx, place.dmaId)).has(place.zoneId)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That DMA is not in that zone" });
  }
  if (place.schemeId) {
    const below = place.dmaId ?? place.zoneId;
    if (below && !(await ancestorsOf(tx, below)).has(place.schemeId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `That ${place.dmaId ? "DMA" : "zone"} is not in that scheme` });
    }
  }
  if (place.routeId) {
    const found = (await routesById(tx, [place.routeId])).get(place.routeId);
    if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "The route was not found" });
    if (found.archivedAt && changed.has("routeId")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${found.name} is archived` });
  }
}

/** A limited member only places service points inside their own scope. */
export function assertPlacementInScope(viewer: Viewer, place: Placement): void {
  if (placementInScope(viewer.scope, place)) return;
  const empty = !place.schemeId && !place.zoneId && !place.dmaId && !place.routeId;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: empty ? "Choose an area or route inside your scope" : "That area or route is outside your scope",
  });
}
