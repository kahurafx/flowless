import type { WorkRegistry } from "../../kernel/work";
import { router } from "../../trpc";
import { attachmentRulesRouter } from "./attachment-rules";
import { connectionsRouter } from "./connections";
import { dmasRouter } from "./dmas";
import { logsRouter } from "./logs";
import { nodesRouter } from "./nodes";
import { pipesRouter } from "./pipes";
import { gisProcedures } from "./procedures";
import { reportsRouter } from "./reports";
import { structuresRouter } from "./structures";
import { subnetworksRouter } from "./subnetworks";
import { tiersRouter } from "./tiers";
import { traceRouter } from "./trace";
import { reconcileRouter } from "./versioning/post";

/**
 * The GIS router (G-01 to G-03, K-02 map data), ported from Majimap. Built over a work
 * registry (branch guards, annotators, the asset-work lookup), so tests can bring their own;
 * `root.ts` passes the wired one.
 */
export function createGisRouter(work: WorkRegistry) {
  const p = gisProcedures(work);
  return router({
    nodes: nodesRouter(p),
    structures: structuresRouter(p),
    pipes: pipesRouter(p),
    connections: connectionsRouter(p),
    dmas: dmasRouter(p),
    tiers: tiersRouter(p),
    subnetworks: subnetworksRouter(p),
    attachmentRules: attachmentRulesRouter(p),
    trace: traceRouter(p),
    logs: logsRouter(p),
    reconcile: reconcileRouter(p),
    reports: reportsRouter(p),
  });
}
