import type { Transaction } from "@flowless/db";
import { node, pipe } from "@flowless/db/schema/gis";
import { listEffective } from "./versioning/engine";

export type NodeRow = typeof node.$inferSelect;
export type PipeRow = typeof pipe.$inferSelect;

/**
 * What a trace result says about a node: enough to list it or find it on the map. Callers
 * that want the full record fetch it with `nodes.byId`.
 */
export type NodeRef = { id: string; name: string; type: NodeRow["type"] };

export const toNodeRef = (row: NodeRow): NodeRef => ({ id: row.id, name: row.name, type: row.type });

/**
 * The network as a branch sees it: every live node and pipe, with the branch's edits laid
 * over main's. Rows satisfy @flowless/network's structural node and pipe shapes directly.
 * Loads the whole network per call: fine at the size this is built for, and it keeps the
 * answer identical to what the client-side traces compute.
 */
export async function loadNetwork(tx: Transaction, orgId: string, branch: string) {
  const nodes = await listEffective(tx, node, { orgId, branch });
  const pipes = await listEffective(tx, pipe, { orgId, branch });
  return { nodes, pipes };
}
