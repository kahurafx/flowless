import type { Transaction } from "@flowless/db";
import { node, pipe, serviceConnection, structure } from "@flowless/db/schema/gis";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { MAIN } from "./common";
import type { GisCtx } from "./versioning/branch-write";
import { listEffective, type VersionedRow } from "./versioning/engine";

/** Who deleted something and when: a tombstone is a version, so its own stamps say. */
export const deletedStamp = (row: Pick<VersionedRow, "createdAt" | "createdByUserId">) => ({
  deletedAt: row.createdAt,
  deletedByUserId: row.createdByUserId,
});

/**
 * What deleting an asset would mean, for the confirmation dialog.
 * - `blockers`: why it can't be deleted yet. The delete itself would refuse with the same messages.
 * - `connected`: the assets behind those blockers, by name.
 * - `warnings`: it can be deleted, but something will be left different.
 * - `openJobs`: unfinished jobs on it (through the kernel's asset-work port). They carry
 *   on, showing the asset as unavailable.
 */
export type DeleteImpact = {
  blockers: string[];
  connected: string[];
  warnings: string[];
  openJobs: { code: string; title: string }[];
};

/** Runs the same guards the delete runs, collecting their refusals instead of stopping at the first. */
export async function collectBlockers(guards: (() => Promise<unknown>)[]): Promise<string[]> {
  const blockers: string[] = [];
  for (const guard of guards) {
    try {
      await guard();
    } catch (err) {
      if (err instanceof TRPCError && err.code === "CONFLICT") blockers.push(err.message);
      else throw err;
    }
  }
  return blockers;
}

export const openJobsOn = (ctx: GisCtx, assetId: string) => ctx.work.openWorkOn(ctx.tx, assetId);

/** A pipe as a person would describe it, from the end they aren't looking at. */
function describePipe(p: { material: string; diameterMm: number }, otherEnd: string | undefined) {
  const label = `${p.diameterMm} mm ${p.material.replaceAll("_", " ")} pipe`;
  return otherEnd ? `${label} to ${otherEnd}` : label;
}

/** The live pipes ending on a node, named by where they lead. */
export async function pipesOnNode(tx: Transaction, orgId: string, nodeId: string): Promise<string[]> {
  const attached = await listEffective(tx, pipe, { orgId, branch: MAIN, where: or(eq(pipe.fromNodeId, nodeId), eq(pipe.toNodeId, nodeId)) });
  if (attached.length === 0) return [];
  const others = attached.map((p) => (p.fromNodeId === nodeId ? p.toNodeId : p.fromNodeId));
  const names = new Map((await listEffective(tx, node, { orgId, branch: MAIN, where: inArray(node.id, others) })).map((n) => [n.id, n.name]));
  return attached.map((p) => describePipe(p, names.get(p.fromNodeId === nodeId ? p.toNodeId : p.fromNodeId)));
}

/** End nodes that deleting this pipe would leave with no pipes at all. Worth saying: they drop out of every trace. */
export async function nodesStrandedBy(tx: Transaction, orgId: string, p: { id: string; fromNodeId: string; toNodeId: string }): Promise<string[]> {
  const ends = [p.fromNodeId, p.toNodeId];
  const others = await listEffective(tx, pipe, { orgId, branch: MAIN, where: or(inArray(pipe.fromNodeId, ends), inArray(pipe.toNodeId, ends)) });
  const stillConnected = new Set(others.filter((o) => o.id !== p.id).flatMap((o) => [o.fromNodeId, o.toNodeId]));
  const stranded = ends.filter((id) => !stillConnected.has(id));
  if (stranded.length === 0) return [];
  const rows = await listEffective(tx, node, { orgId, branch: MAIN, where: inArray(node.id, stranded) });
  return rows.map((n) => n.name);
}

/** The live connections a pipe serves, by number. */
export async function connectionsOnPipe(tx: Transaction, orgId: string, branch: string, pipeId: string): Promise<string[]> {
  const rows = await listEffective(tx, serviceConnection, { orgId, branch, where: eq(serviceConnection.pipeId, pipeId) });
  return rows.map((r) => `Connection ${r.connectionNumber}`);
}

/**
 * A pipe can't be deleted while it serves a connection: that connection would stop
 * counting in a break, silently. Called by `pipes.delete`, and by `deleteImpact`.
 */
export async function assertPipeServesNobody(tx: Transaction, orgId: string, branch: string, pipeId: string) {
  const served = await connectionsOnPipe(tx, orgId, branch, pipeId);
  if (served.length > 0) {
    const one = served.length === 1;
    throw new TRPCError({ code: "CONFLICT", message: `${served.length} connection${one ? " is" : "s are"} served by this pipe: relink ${one ? "it" : "them"} first` });
  }
}

/** The asset is real but deleted, so a retry will never help. Distinct from NOT_FOUND, which a device takes to mean "not arrived yet". */
export const assetDeleted = (noun = "asset") => new TRPCError({ code: "CONFLICT", message: `That ${noun} has been deleted` });

/** Ids of assets deleted on main, for "not in" clauses over logs. `column` is the log's asset id column. Relies on RLS for the tenant. */
export function notDeletedAsset(column: SQL | unknown): SQL {
  const tombstones = (table: typeof node | typeof pipe | typeof structure) =>
    sql`select ${table.id} from ${table} where ${and(eq(table.branch, MAIN), eq(table.isHead, true), eq(table.isDeleted, true))}`;
  return sql`${column} not in (${tombstones(node)} union all ${tombstones(pipe)} union all ${tombstones(structure)})`;
}
