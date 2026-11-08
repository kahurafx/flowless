import type { Transaction } from "@flowless/db";
import { asset, conditionLog, node, pipe, serviceConnection, structure, valveStateLog } from "@flowless/db/schema/gis";
import { DUPLICATE_RADIUS_M } from "@flowless/shared-types";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { AssetRef, AssetResolver, EvidenceRef, EvidenceResolver } from "../../../kernel/work";
import { MAIN } from "../common";

/*
 * GIS's side of the kernel's work ports (ported from Majimap's link/resolvers.ts). This is
 * the only place Work Orders' questions about assets and evidence turn into GIS queries;
 * GIS still doesn't know work orders exist. Everything runs under the caller's RLS.
 * Flowless: identity comes from `gis.asset`, labels and locations from the head version
 * (main's when live there, otherwise the branch proposing it); locations leave as GeoPoint.
 * DMAs are kernel areas, not GIS assets, so jobs reach them as areas.
 */

type HeadRow = { id: string; branch: string; isDeleted: boolean; name: string; type: string; location: { lat: number; lng: number } | null };

/** Every live head of the given ids, across the four versioned asset tables. */
async function liveHeads(tx: Transaction, ids: readonly string[]): Promise<HeadRow[]> {
  if (ids.length === 0) return [];
  const live = <T extends typeof node | typeof pipe | typeof structure | typeof serviceConnection>(table: T) =>
    and(eq(table.isHead, true), eq(table.isDeleted, false), inArray(table.id, [...ids]));
  const rows: HeadRow[] = [];
  for (const r of await tx
    .select({ id: node.id, branch: node.branch, name: node.name, type: node.type, location: node.location })
    .from(node)
    .where(live(node)))
    rows.push({ ...r, isDeleted: false });
  for (const r of await tx
    .select({ id: structure.id, branch: structure.branch, name: structure.name, location: structure.location })
    .from(structure)
    .where(live(structure)))
    rows.push({ ...r, type: "structure", isDeleted: false });
  for (const r of await tx.select({ id: pipe.id, branch: pipe.branch }).from(pipe).where(live(pipe)))
    rows.push({ ...r, name: `Pipe ${r.id.slice(0, 8)}`, type: "pipe", location: null, isDeleted: false });
  for (const r of await tx
    .select({ id: serviceConnection.id, branch: serviceConnection.branch, number: serviceConnection.connectionNumber, location: serviceConnection.location })
    .from(serviceConnection)
    .where(live(serviceConnection)))
    rows.push({ id: r.id, branch: r.branch, name: `Connection ${r.number}`, type: "service_connection", location: r.location, isDeleted: false });
  return rows;
}

/** The registered asset of the same type nearest to a proposed one, if any is within the radius. */
async function nearbyRegistered(tx: Transaction, ref: { id: string; type: string; location: { lat: number; lng: number } }): Promise<string | null> {
  const point = sql`ST_SetSRID(ST_MakePoint(${ref.location.lng}, ${ref.location.lat}), 4326)::geography`;
  const onMain = <T extends typeof node | typeof structure>(table: T) =>
    and(eq(table.branch, MAIN), eq(table.isHead, true), eq(table.isDeleted, false), ne(table.id, ref.id), sql`ST_DWithin(${table.location}::geography, ${point}, ${DUPLICATE_RADIUS_M})`);
  if (ref.type === "structure") {
    const [near] = await tx.select({ id: structure.id }).from(structure).where(onMain(structure)).limit(1);
    return near?.id ?? null;
  }
  if (ref.type === "pipe" || ref.type === "service_connection") return null;
  const [near] = await tx
    .select({ id: node.id })
    .from(node)
    .where(and(onMain(node), sql`${node.type}::text = ${ref.type}`))
    .limit(1);
  return near?.id ?? null;
}

export const gisAssetResolver: AssetResolver = {
  module: "gis",
  async resolve(tx, ids) {
    const found = new Map<string, AssetRef>();
    const wanted = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (wanted.length === 0) return found;
    const known = await tx.select({ id: asset.id }).from(asset).where(inArray(asset.id, wanted));
    const heads = await liveHeads(
      tx,
      known.map((k) => k.id),
    );
    for (const { id } of known) {
      const mine = heads.filter((h) => h.id === id);
      const registered = mine.find((h) => h.branch === MAIN);
      const shown = registered ?? mine[0];
      // Not live anywhere (deleted, or its only branch was discarded): as far as a job is concerned it doesn't exist.
      if (!shown) continue;
      found.set(id, {
        id,
        module: "gis",
        type: shown.type,
        name: shown.name,
        location: shown.location ? { latitude: shown.location.lat, longitude: shown.location.lng } : null,
        state: registered ? "registered" : "proposed",
        possibleDuplicateOf: registered || !shown.location ? null : await nearbyRegistered(tx, { id, type: shown.type, location: shown.location }),
      });
    }
    return found;
  },
};

export const gisEvidenceResolver: EvidenceResolver = {
  module: "gis",
  kinds: ["condition", "valve"],
  async find(tx, kind, id): Promise<EvidenceRef | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    if (kind === "condition") {
      const [row] = await tx
        .select({ assetId: conditionLog.assetId, by: conditionLog.recordedByUserId, at: conditionLog.recordedAt, branch: conditionLog.branch })
        .from(conditionLog)
        .where(eq(conditionLog.id, id))
        .limit(1);
      return row ? { kind, id, assetId: row.assetId, recordedByUserId: row.by, recordedAt: row.at, branch: row.branch } : null;
    }
    if (kind === "valve") {
      const [row] = await tx
        .select({ assetId: valveStateLog.valveId, by: valveStateLog.changedByUserId, at: valveStateLog.changedAt, branch: valveStateLog.branch })
        .from(valveStateLog)
        .where(eq(valveStateLog.id, id))
        .limit(1);
      return row ? { kind, id, assetId: row.assetId, recordedByUserId: row.by, recordedAt: row.at, branch: row.branch } : null;
    }
    return null;
  },
};
