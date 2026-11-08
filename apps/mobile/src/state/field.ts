import { personalBranch, MAIN_BRANCH, type AssetCondition, type NodeType, type PipeMaterial, type StructureType } from "@flowless/shared-types";
import { createContext, useContext, useMemo } from "react";
import { toUploadSpec } from "../lib/attachments";
import { approxMetres, CONDITION_LABEL } from "../lib/format";
import { now, uid } from "../lib/ids";
import type { Abilities } from "../lib/permissions";
import { createOps, uploadOps } from "../lib/sync/build";
import type { Op } from "../lib/sync/ops";
import type { AppNode, LatLng, LocalFile, Pipe, WorkKind } from "../lib/types";
import { kindInfo, usesJobBranch } from "../lib/work-orders";
import type { NetworkValue } from "./network";
import type { JobLinks } from "./jobs";
import type { Enqueue } from "./sync";
import { useActions } from "./use-actions";

/**
 * Field actions on the network (G-01, G-02): inspections, valve operations and capturing nodes,
 * pipes, structures and service connections. Each one updates the phone at once and queues the exact
 * tRPC call(s) it stands for.
 *
 * Where a change goes (the "branch"):
 *  - for a job whose kind works on the network (`gis` logs, edits or creates), on the job's branch
 *    `wo-<code>`. The branch name is asked of the server when the op is sent (a job raised on this
 *    phone has no code yet);
 *  - for a job of another kind, logs go on main (that is where Work Orders links them from), and a
 *    member who may not post to main records them as history only (outcome `stale`);
 *  - with no job, on main for a member who may post, otherwise on their personal branch `fld-<id>`,
 *    which an engineer reviews.
 */
export type NewNode = {
  type: NodeType;
  name: string;
  location: LatLng;
  condition: AssetCondition;
  isOpen: boolean | null;
  structureId: string | null;
  junction: { type: "tee" | "cross" | "elbow" | "wye" | "reducer"; mainSizeMm: number; branchSizeMm: number | null } | null;
  files: LocalFile[];
};
export type NewPipe = { fromNodeId: string; toNodeId: string; material: PipeMaterial; diameterMm: number; condition: AssetCondition };
export type NewStructure = { type: StructureType; name: string; location: LatLng; condition: AssetCondition; files: LocalFile[] };
export type NewConnection = { connectionNumber: string; location: LatLng; pipeId: string | null };

export type FieldValue = {
  recordCondition: (assetId: string, condition: AssetCondition, note: string, workOrderId?: string, files?: LocalFile[]) => void;
  operateValve: (valveId: string, isOpen: boolean, note: string, workOrderId?: string) => void;
  /** With a job, the asset goes on that job's branch and joins the job as a proposed asset. */
  addNode: (input: NewNode, workOrderId?: string) => void;
  addPipe: (input: NewPipe, workOrderId?: string) => void;
  addStructure: (input: NewStructure, workOrderId?: string) => void;
  addConnection: (input: NewConnection, workOrderId?: string) => void;
};

export const FieldContext = createContext<FieldValue | null>(null);
export function useField(): FieldValue {
  const v = useContext(FieldContext);
  if (!v) throw new Error("useField must be used inside <AppProvider>");
  return v;
}

type Deps = {
  userId: string;
  abilities: Abilities;
  kinds: readonly WorkKind[];
  network: NetworkValue;
  setNodes: (fn: (nodes: AppNode[]) => AppNode[]) => void;
  setPipes: (fn: (pipes: Pipe[]) => Pipe[]) => void;
  setStructures: (fn: (rows: NetworkValue["structures"]) => NetworkValue["structures"]) => void;
  setConnections: (fn: (rows: NetworkValue["connections"]) => NetworkValue["connections"]) => void;
  setConditionLogs: (fn: (rows: NetworkValue["conditionLogs"]) => NetworkValue["conditionLogs"]) => void;
  setValveLogs: (fn: (rows: NetworkValue["valveLogs"]) => NetworkValue["valveLogs"]) => void;
  jobs: JobLinks;
  enqueue: Enqueue;
};

export function useFieldValue(deps: Deps): FieldValue {
  const { userId, abilities, kinds, network, jobs, enqueue } = deps;

  /** Where a new asset or edit goes. `workOrderId` on the result means "ask the server for the job's branch". */
  const placeFor = (workOrderId?: string): { branch: string; workOrderId?: string } => {
    const job = workOrderId ? jobs.orderOf(workOrderId) : undefined;
    if (job && usesJobBranch(kindInfo(kinds, job.kind))) return { branch: job.branch ?? job.code.toLowerCase(), workOrderId: job.id };
    return { branch: personalBranch(userId) };
  };

  /** Logs follow the same rule, except that outside a job a member who may post records straight on main. */
  const logPlaceFor = (workOrderId?: string): { branch: string; workOrderId?: string } => {
    const job = workOrderId ? jobs.orderOf(workOrderId) : undefined;
    if (job) return usesJobBranch(kindInfo(kinds, job.kind)) ? placeFor(workOrderId) : { branch: MAIN_BRANCH };
    return abilities.post ? { branch: MAIN_BRANCH } : { branch: personalBranch(userId) };
  };

  const linkOp = (workOrderId: string | undefined, logKind: "condition" | "valve", logId: string, at: string): Op[] =>
    workOrderId ? [{ proc: "workOrders.linkLog", input: { eventId: uid(), workOrderId, logKind, logId, occurredAt: at } }] : [];

  const nameOf = (id: string) => network.nodes.find((n) => n.id === id)?.name ?? "Asset";
  const jobDetail = (workOrderId?: string) => {
    const job = workOrderId ? jobs.orderOf(workOrderId) : undefined;
    return job ? `On ${job.code}'s changes` : abilities.post ? "Added to the network" : "Added to your changes";
  };
  const joinJob = (workOrderId: string | undefined, assetId: string, name: string, type: string): Op[] => {
    if (!workOrderId) return [];
    jobs.attachToJob(workOrderId, { assetId, name, type, state: "proposed" });
    return [{ proc: "workOrders.addAsset", input: { eventId: uid(), workOrderId, assetId, occurredAt: now() } }];
  };

  const recordCondition: FieldValue["recordCondition"] = (assetId, condition, note, workOrderId, files = []) => {
    const at = now();
    const place = logPlaceFor(workOrderId);
    const id = uid();
    const cleaned = note.trim();
    deps.setNodes((ns) => ns.map((n) => (n.id === assetId ? { ...n, condition, lastInspectedAt: new Date(at) } : n)));
    deps.setConditionLogs((l) => [
      { id, assetId, assetType: "node", nodeId: assetId, pipeId: null, structureId: null, condition, note: cleaned || null, recordedAt: new Date(at), recordedByUserId: userId, syncedAt: null, branch: place.branch },
      ...l,
    ]);
    enqueue({ kind: "condition", assetId, title: "Inspection", assetName: nameOf(assetId), detail: CONDITION_LABEL[condition] }, [
      { proc: "gis.logs.recordCondition", ...(place.workOrderId ? { workOrderId: place.workOrderId } : {}), input: { id, assetId, branch: place.branch, condition, note: cleaned, recordedAt: at } },
      ...linkOp(workOrderId, "condition", id, at),
      ...uploadOps(files.map(toUploadSpec), { kind: "gis_asset", id: assetId }),
    ]);
    const node = network.nodes.find((n) => n.id === assetId);
    if (workOrderId && node) jobs.touchOrder(workOrderId, node);
  };

  const operateValve: FieldValue["operateValve"] = (valveId, isOpen, note, workOrderId) => {
    const at = now();
    const place = logPlaceFor(workOrderId);
    const id = uid();
    const cleaned = note.trim();
    deps.setNodes((ns) => ns.map((n) => (n.id === valveId ? { ...n, isOpen } : n)));
    deps.setValveLogs((l) => [{ id, nodeId: valveId, isOpen, changedAt: new Date(at), changedByUserId: userId, syncedAt: null, note: cleaned || null, branch: place.branch }, ...l]);
    enqueue({ kind: "valve", assetId: valveId, title: "Valve operated", assetName: nameOf(valveId), detail: isOpen ? "Open" : "Closed" }, [
      { proc: "gis.logs.recordValveState", ...(place.workOrderId ? { workOrderId: place.workOrderId } : {}), input: { id, valveId, branch: place.branch, isOpen, note: cleaned, changedAt: at } },
      ...linkOp(workOrderId, "valve", id, at),
    ]);
    const node = network.nodes.find((n) => n.id === valveId);
    if (workOrderId && node) jobs.touchOrder(workOrderId, node);
  };

  const addNode: FieldValue["addNode"] = (input, workOrderId) => {
    const id = uid();
    const place = placeFor(workOrderId);
    const { files, ...fields } = input;
    deps.setNodes((ns) => [
      ...ns,
      { id, versionId: "", branch: place.branch, installedAt: null, lastInspectedAt: null, ...fields, attachments: files, pending: true },
    ]);
    const create: Op = { proc: "gis.nodes.create", ...(place.workOrderId ? { workOrderId: place.workOrderId } : {}), input: { id, branch: place.branch, ...fields } };
    const [create1, ...uploads] = createOps(create, files.map(toUploadSpec), { kind: "gis_asset", id });
    enqueue({ kind: "create", assetId: id, title: "New asset", assetName: input.name, detail: jobDetail(workOrderId) }, [create1!, ...joinJob(workOrderId, id, input.name, input.type), ...uploads]);
  };

  const addPipe: FieldValue["addPipe"] = (input, workOrderId) => {
    const from = network.nodes.find((n) => n.id === input.fromNodeId);
    const to = network.nodes.find((n) => n.id === input.toNodeId);
    if (!from || !to) return;
    const id = uid();
    const place = placeFor(workOrderId);
    const path = [from.location, to.location];
    deps.setPipes((ps) => [...ps, { id, versionId: "", branch: place.branch, path, lengthM: approxMetres(from.location, to.location), ...input }]);
    const name = `${from.name} to ${to.name}`;
    enqueue({ kind: "create", assetId: id, title: "New pipe", assetName: name, detail: `${Math.round(input.diameterMm)} mm · ${jobDetail(workOrderId)}` }, [
      { proc: "gis.pipes.create", ...(place.workOrderId ? { workOrderId: place.workOrderId } : {}), input: { id, branch: place.branch, path, ...input } },
      ...joinJob(workOrderId, id, name, "pipe"),
    ]);
  };

  const addStructure: FieldValue["addStructure"] = (input, workOrderId) => {
    const id = uid();
    const place = placeFor(workOrderId);
    const { files, ...fields } = input;
    deps.setStructures((ss) => [...ss, { id, versionId: "", branch: place.branch, installedAt: null, lastInspectedAt: null, ...fields }]);
    const create: Op = { proc: "gis.structures.create", ...(place.workOrderId ? { workOrderId: place.workOrderId } : {}), input: { id, branch: place.branch, ...fields } };
    const [create1, ...uploads] = createOps(create, files.map(toUploadSpec), { kind: "gis_asset", id });
    enqueue({ kind: "create", assetId: id, title: `New ${input.type}`, assetName: input.name, detail: jobDetail(workOrderId) }, [create1!, ...joinJob(workOrderId, id, input.name, "structure"), ...uploads]);
  };

  const addConnection: FieldValue["addConnection"] = (input, workOrderId) => {
    const id = uid();
    const place = placeFor(workOrderId);
    deps.setConnections((cs) => [...cs, { id, versionId: "", branch: place.branch, servicePointId: null, ...input }]);
    enqueue({ kind: "create", assetId: id, title: "New connection", assetName: input.connectionNumber, detail: jobDetail(workOrderId) }, [
      { proc: "gis.connections.create", ...(place.workOrderId ? { workOrderId: place.workOrderId } : {}), input: { id, branch: place.branch, ...input } },
      ...joinJob(workOrderId, id, `Connection ${input.connectionNumber}`, "service_connection"),
    ]);
  };

  const actions = useActions({ recordCondition, operateValve, addNode, addPipe, addStructure, addConnection });
  return useMemo(() => actions, [actions]);
}
