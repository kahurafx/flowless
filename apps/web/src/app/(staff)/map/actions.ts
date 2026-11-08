"use server";

import type { AssetCondition, NodeType, PipeMaterial } from "@flowless/shared-types";
import { runAction } from "@/data/run-action";

/*
 * Every network edit goes through the GIS procedures on a branch: the live network needs
 * `gis:post`, a job's branch is guarded by Work Orders, a personal `fld-` branch by its owner.
 * The map re-reads its data after each one (`runAction` refreshes).
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export async function createNode(input: { branch: string; type: NodeType; name: string; location: LatLng; condition: AssetCondition; isOpen: boolean | null }) {
  return runAction((api) => api.gis.nodes.create({ ...input, id: crypto.randomUUID() }));
}

export async function updateNode(input: {
  branch: string;
  id: string;
  baseVersionId: string;
  patch: { name?: string; location?: LatLng; condition?: AssetCondition; isOpen?: boolean | null };
}) {
  return runAction((api) => api.gis.nodes.update(input));
}

export async function createPipe(input: { branch: string; fromNodeId: string; toNodeId: string; path: LatLng[]; material: PipeMaterial; diameterMm: number; condition: AssetCondition }) {
  return runAction((api) => api.gis.pipes.create({ ...input, id: crypto.randomUUID() }));
}

export async function updatePipe(input: {
  branch: string;
  id: string;
  baseVersionId: string;
  patch: { path?: LatLng[]; material?: PipeMaterial; diameterMm?: number; condition?: AssetCondition };
}) {
  return runAction((api) => api.gis.pipes.update(input));
}

export async function deleteAsset(input: { kind: "node" | "pipe"; id: string; baseVersionId: string; branch: string }) {
  const { kind, ...rest } = input;
  return runAction((api) => (kind === "node" ? api.gis.nodes.delete(rest) : api.gis.pipes.delete(rest)));
}

/** What deleting would mean, for the confirmation: blockers, what is connected, open jobs. Looks at the live network. */
export async function deleteImpact(input: { kind: "node" | "pipe"; id: string }) {
  return runAction((api) => (input.kind === "node" ? api.gis.nodes.deleteImpact({ id: input.id }) : api.gis.pipes.deleteImpact({ id: input.id })), { refresh: false });
}

export async function createDma(input: {
  branch: string;
  areaId: string;
  color: string;
  tierId: string;
  inletMeterId: string;
  boundaryValveIds: string[];
  ring: LatLng[];
}) {
  return runAction((api) => api.gis.dmas.create(input));
}

export async function updateDma(input: {
  branch: string;
  id: string;
  baseVersionId: string;
  patch: { color?: string; tierId?: string; inletMeterId?: string; boundaryValveIds?: string[]; ring?: LatLng[] };
}) {
  return runAction((api) => api.gis.dmas.update(input));
}

/**
 * Records an inspection (a condition log) on the branch. With a job, the log is then linked to it
 * (Work Orders only takes a log recorded on the job's own branch); a link that is refused leaves the
 * log recorded and says why.
 */
export async function recordCondition(input: { branch: string; assetId: string; condition: AssetCondition; note: string; jobId?: string }) {
  const { jobId, ...log } = input;
  return runAction(async (api) => {
    const id = crypto.randomUUID();
    const result = await api.gis.logs.recordCondition({ ...log, id, note: log.note.trim() || null });
    return { outcome: result.outcome, linked: jobId ? await link(api, jobId, "condition", id) : null };
  });
}

/** Records a valve operation (opened or closed), with the same job linking as an inspection. */
export async function recordValveOperation(input: { branch: string; valveId: string; isOpen: boolean; note: string; jobId?: string }) {
  const { jobId, ...log } = input;
  return runAction(async (api) => {
    const id = crypto.randomUUID();
    const result = await api.gis.logs.recordValveState({ ...log, id, note: log.note.trim() || null });
    return { outcome: result.outcome, linked: jobId ? await link(api, jobId, "valve", id) : null };
  });
}

type Api = Parameters<Parameters<typeof runAction>[0]>[0];
async function link(api: Api, workOrderId: string, logKind: "condition" | "valve", logId: string): Promise<string> {
  try {
    const settled = await api.workOrders.linkLog({ eventId: crypto.randomUUID(), workOrderId, logKind, logId });
    return settled.outcome === "rejected" || settled.outcome === "stale" ? `Recorded, but not linked to the job: ${settled.reason ?? "refused"}` : "Linked to the job";
  } catch (error) {
    return `Recorded, but not linked to the job: ${error instanceof Error ? error.message : "refused"}`;
  }
}

export async function conditionHistory(assetId: string) {
  return runAction((api) => api.gis.logs.conditionHistory({ assetId, limit: 5 }), { refresh: false });
}

export async function valveHistory(valveId: string) {
  return runAction((api) => api.gis.logs.valveHistory({ valveId, limit: 5 }), { refresh: false });
}
