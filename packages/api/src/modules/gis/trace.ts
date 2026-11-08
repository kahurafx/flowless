import { affectedConnections, traceDirectional, traceIsolation } from "@flowless/network";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router } from "../../trpc";
import { BranchSchema, EntityId, MAIN } from "./common";
import { listConnections } from "./connections";
import { loadNetwork, toNodeRef } from "./network-view";
import type { GisProcedures } from "./procedures";

/**
 * Network traces against the stored network (G-03): the same @flowless/network algorithms
 * the clients run on their cached copy, so what the server says and what a phone says
 * offline can't drift apart. Upstream/downstream is hop distance from the nearest source.
 */
export function traceRouter(p: GisProcedures) {
  return router({
    directional: p.read
      .input(z.object({ startNodeId: EntityId, direction: z.enum(["upstream", "downstream"]), branch: BranchSchema.default(MAIN) }))
      .query(async ({ ctx, input }) => {
        const network = await loadNetwork(ctx.tx, ctx.organizationId, input.branch);
        if (!network.nodes.some((n) => n.id === input.startNodeId)) throw new TRPCError({ code: "NOT_FOUND", message: "Node not found" });
        return { nodes: traceDirectional(input.startNodeId, input.direction, network.nodes, network.pipes).map(toNodeRef) };
      }),

    /** What a break on this pipe cuts off, and what an operator has to do about it. `skipValveIds`: "that valve won't operate". */
    isolation: p.read
      .input(z.object({ failedPipeId: EntityId, skipValveIds: z.array(EntityId).max(500).default([]), branch: BranchSchema.default(MAIN) }))
      .query(async ({ ctx, input }) => {
        const network = await loadNetwork(ctx.tx, ctx.organizationId, input.branch);
        if (!network.pipes.some((x) => x.id === input.failedPipeId)) throw new TRPCError({ code: "NOT_FOUND", message: "Pipe not found" });
        const result = traceIsolation(input.failedPipeId, network.nodes, network.pipes, input.skipValveIds);
        return {
          affectedNodes: result.affectedNodes.map(toNodeRef),
          valvesToClose: result.valvesToClose.map(toNodeRef),
          alreadyClosed: result.alreadyClosed.map(toNodeRef),
          unisolatedSources: result.unisolatedSources.map(toNodeRef),
          /** The connections it reaches. */
          connections: affectedConnections(
            input.failedPipeId,
            network.nodes,
            network.pipes,
            await listConnections(ctx.tx, ctx.organizationId, input.branch),
            input.skipValveIds,
          ),
        };
      }),
  });
}
