import type { LatLng, Transaction } from "@flowless/db";
import { dma, dmaBoundaryValve, node, tier } from "@flowless/db/schema/gis";
import { dmaMembership } from "@flowless/network";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { areasById } from "../../kernel/areas";
import { router } from "../../trpc";
import { BranchSchema, compact, EntityId, GeoPointInput, guarded, MAIN, nonEmpty, VersionId } from "./common";
import { areaNames, loadBoundaryValves, writeBoundaryValves } from "./dma-store";
import { isDegenerateRing } from "./geo";
import { loadNetwork } from "./network-view";
import type { GisProcedures } from "./procedures";
import { assertBranchWritable } from "./versioning/branch-write";
import { editVersioned, listEffective, loadEffective, loadHistory, normalize, toHistoryEntry, type RowOf } from "./versioning/engine";

type DmaRow = RowOf<typeof dma>;

/**
 * GIS map data on the kernel's DMA (K-02): the DMA itself is a kernel area of level "dma",
 * so `id` here IS that area's id and the name is the area's. What GIS adds, versioned per
 * branch like the network: boundary polygon, colour, tier, inlet meter, boundary valves.
 */
export function toDmaDto(row: DmaRow, boundaryValveIds: readonly string[], name: string) {
  return {
    id: row.areaId,
    versionId: row.versionId,
    branch: row.branch,
    name,
    color: row.color,
    tierId: row.tierId,
    inletMeterId: row.inletMeterId,
    boundaryValveIds: [...boundaryValveIds],
    ring: row.boundary,
  };
}
export type DmaDto = ReturnType<typeof toDmaDto>;

async function present(tx: Transaction, rows: DmaRow[]) {
  const valves = await loadBoundaryValves(
    tx,
    rows.map((r) => r.versionId),
  );
  const names = await areaNames(
    tx,
    rows.map((r) => r.areaId),
  );
  return rows.map((row) => toDmaDto(row, valves.get(row.versionId) ?? [], names.get(row.areaId) ?? "DMA"));
}

/** Everything a DMA points at has to exist as the right thing, as the caller's branch sees it. */
async function assertDmaReferences(
  tx: Transaction,
  args: { orgId: string; branch: string; tierId: string; inletMeterId: string | null; boundaryValveIds: readonly string[]; ring: readonly LatLng[] },
) {
  const { orgId, branch, tierId, inletMeterId, boundaryValveIds, ring } = args;
  const [found] = await tx.select({ id: tier.id }).from(tier).where(eq(tier.id, tierId)).limit(1);
  if (!found) throw new TRPCError({ code: "BAD_REQUEST", message: "That tier doesn't exist in this organization" });

  const wanted = [...new Set([...(inletMeterId ? [inletMeterId] : []), ...boundaryValveIds])];
  const nodes = wanted.length ? await listEffective(tx, node, { orgId, branch, where: inArray(node.id, wanted) }) : [];
  const typeOf = new Map(nodes.map((n) => [n.id, n.type]));
  if (inletMeterId && typeOf.get(inletMeterId) !== "meter") throw new TRPCError({ code: "BAD_REQUEST", message: "A DMA's inlet must be an existing meter" });
  for (const valveId of boundaryValveIds) {
    if (typeOf.get(valveId) !== "valve") throw new TRPCError({ code: "BAD_REQUEST", message: `Boundary valve ${valveId} must be an existing valve` });
  }
  if (isDegenerateRing(ring)) throw new TRPCError({ code: "BAD_REQUEST", message: "A DMA boundary needs at least three corners that enclose some area" });
}

/** The kernel area must be this organization's, a live DMA (read through the kernel's hierarchy). */
async function assertDmaArea(tx: Transaction, areaId: string) {
  const found = (await areasById(tx, [areaId])).get(areaId);
  if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Area not found" });
  if (found.level !== "dma") throw new TRPCError({ code: "BAD_REQUEST", message: `${found.name} is a ${found.level.replace("_", " ")}, not a DMA` });
  if (found.archivedAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${found.name} is archived` });
}

/**
 * A node can't be deleted while a DMA still uses it as its inlet meter or one of its
 * boundary valves, judged by what the caller's branch sees. Called by `nodes.delete`.
 */
export async function assertNodeNotUsedByDma(tx: Transaction, orgId: string, branch: string, nodeId: string) {
  const inScope = and(eq(dma.organizationId, orgId), eq(dma.isHead, true), inArray(dma.branch, [MAIN, branch]));
  const byInlet = await tx
    .selectDistinct({ id: dma.areaId })
    .from(dma)
    .where(and(inScope, eq(dma.inletMeterId, nodeId)));
  const byValve = await tx
    .selectDistinct({ id: dma.areaId })
    .from(dma)
    .innerJoin(dmaBoundaryValve, eq(dmaBoundaryValve.dmaVersionId, dma.versionId))
    .where(and(inScope, eq(dmaBoundaryValve.valveId, nodeId)));
  const candidateIds = [...new Set([...byInlet, ...byValve].map((row) => row.id))];
  if (candidateIds.length === 0) return;

  const effective = await listEffective(tx, dma, { orgId, branch, where: inArray(dma.areaId, candidateIds) });
  const valves = await loadBoundaryValves(
    tx,
    effective.map((d) => d.versionId),
  );
  const users = effective.filter((d) => d.inletMeterId === nodeId || (valves.get(d.versionId) ?? []).includes(nodeId));
  if (users.length > 0) {
    const one = users.length === 1;
    throw new TRPCError({
      code: "CONFLICT",
      message: `${users.length} DMA${one ? " uses" : "s use"} this node as an inlet meter or boundary valve: update ${one ? "it" : "them"} first`,
    });
  }
}

const ColorInput = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #3B82F6");
const RingInput = z.array(GeoPointInput).min(3).max(10_000);
const ValveIdsInput = z.array(EntityId).max(500);

const DmaPatchSchema = z
  .object({ color: ColorInput, tierId: EntityId, inletMeterId: EntityId, boundaryValveIds: ValveIdsInput, ring: RingInput })
  .partial()
  .refine(nonEmpty, "Patch is empty");

export function dmasRouter(p: GisProcedures) {
  return router({
    list: p.read.input(z.object({ branch: BranchSchema.default(MAIN) }).optional()).query(async ({ ctx, input }) => {
      return present(ctx.tx, await listEffective(ctx.tx, dma, { orgId: ctx.organizationId, branch: input?.branch ?? MAIN }));
    }),

    byId: p.read.input(z.object({ id: EntityId, branch: BranchSchema.default(MAIN) })).query(async ({ ctx, input }) => {
      const row = await loadEffective(ctx.tx, dma, { orgId: ctx.organizationId, id: input.id, branch: input.branch });
      if (!row || row.isDeleted) throw new TRPCError({ code: "NOT_FOUND", message: "DMA not found" });
      return (await present(ctx.tx, [row]))[0]!;
    }),

    /** Every version, with the valve set each one had: who changed which valves, and when. */
    history: p.read.input(z.object({ id: EntityId })).query(async ({ ctx, input }) => {
      const rows = await loadHistory(ctx.tx, dma, { orgId: ctx.organizationId, id: input.id });
      if (rows.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "DMA not found" });
      const valves = await loadBoundaryValves(
        ctx.tx,
        rows.map((r) => r.versionId),
      );
      return rows.map((row) => ({
        ...toHistoryEntry(row),
        color: row.color,
        inletMeterId: row.inletMeterId,
        boundaryValveIds: valves.get(row.versionId) ?? [],
      }));
    }),

    /**
     * Does what's CONNECTED to the DMA's inlet match what's DRAWN as its boundary?
     * Membership is traced downstream from the inlet meter and compared against the polygon
     * (@flowless/network `dmaMembership`, the same function the apps run).
     */
    analysis: p.read.input(z.object({ id: EntityId, branch: BranchSchema.default(MAIN) })).query(async ({ ctx, input }) => {
      const row = await loadEffective(ctx.tx, dma, { orgId: ctx.organizationId, id: input.id, branch: input.branch });
      if (!row || row.isDeleted) throw new TRPCError({ code: "NOT_FOUND", message: "DMA not found" });
      const valveIds = (await loadBoundaryValves(ctx.tx, [row.versionId])).get(row.versionId) ?? [];
      const network = await loadNetwork(ctx.tx, ctx.organizationId, input.branch);
      if (!row.inletMeterId || !network.nodes.some((n) => n.id === row.inletMeterId)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "The DMA's inlet meter isn't part of the network in this view" });
      }
      const m = dmaMembership({ inletMeterId: row.inletMeterId, ring: row.boundary, boundaryValveIds: valveIds }, network.nodes, network.pipes);
      return {
        dmaId: row.areaId,
        tracedNodeIds: m.tracedIds,
        outsideBoundary: m.outsideBoundary,
        insideNotTraced: m.insideNotTraced,
        openBoundaryValveIds: m.openBoundaryValveIds,
        sealed: m.sealed,
      };
    }),

    /**
     * Draw a DMA's map data on a kernel DMA area (`areaId`, level "dma"). A retry on the same
     * branch returns what's there; an area that already has map data is CONFLICT (edit it).
     */
    create: p.edit
      .input(
        z.object({
          areaId: EntityId,
          branch: BranchSchema.default(MAIN),
          color: ColorInput,
          tierId: EntityId,
          inletMeterId: EntityId,
          boundaryValveIds: ValveIdsInput.default([]),
          /** Corners in order; closed for you if the last doesn't repeat the first. */
          ring: RingInput,
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const valveIds = [...new Set(input.boundaryValveIds)].sort();
        return guarded(async () => {
          await assertDmaArea(ctx.tx, input.areaId);
          const versions = normalize(dma, await ctx.tx.select().from(dma).where(eq(dma.areaId, input.areaId)));
          if (versions.length > 0) {
            const head = versions.find((v) => v.branch === input.branch && v.isHead && !v.isDeleted);
            if (head) return (await present(ctx.tx, [head]))[0]!;
            throw new TRPCError({ code: "CONFLICT", message: "That DMA already has map data: edit it instead" });
          }
          await assertBranchWritable(ctx, input.branch);
          await assertDmaReferences(ctx.tx, {
            orgId: ctx.organizationId,
            branch: input.branch,
            tierId: input.tierId,
            inletMeterId: input.inletMeterId,
            boundaryValveIds: valveIds,
            ring: input.ring,
          });
          const [row] = await ctx.tx
            .insert(dma)
            .values({
              areaId: input.areaId,
              organizationId: ctx.organizationId,
              branch: input.branch,
              createdByUserId: ctx.session.user.id,
              color: input.color,
              tierId: input.tierId,
              inletMeterId: input.inletMeterId,
              boundary: input.ring,
            })
            .returning();
          await writeBoundaryValves(ctx.tx, ctx.organizationId, row!.versionId, valveIds);
          return (await present(ctx.tx, normalize(dma, [row])))[0]!;
        });
      }),

    update: p.edit
      .input(z.object({ id: EntityId, baseVersionId: VersionId, branch: BranchSchema.default(MAIN), patch: DmaPatchSchema }))
      .mutation(async ({ ctx, input }) => {
        const { patch } = input;
        return guarded(async () => {
          await assertBranchWritable(ctx, input.branch);
          const { previous, next } = await editVersioned(ctx.tx, dma, {
            orgId: ctx.organizationId,
            userId: ctx.session.user.id,
            id: input.id,
            branch: input.branch,
            baseVersionId: input.baseVersionId,
            tombstone: false,
            entity: "DMA",
            patch: compact({ color: patch.color, tierId: patch.tierId, inletMeterId: patch.inletMeterId, boundary: patch.ring }),
          });
          // The new version owns its own valve rows: the replacement set if one was given, otherwise a copy.
          const previousValves = (await loadBoundaryValves(ctx.tx, [previous.versionId])).get(previous.versionId) ?? [];
          const valveIds = patch.boundaryValveIds ? [...new Set(patch.boundaryValveIds)].sort() : previousValves;
          await assertDmaReferences(ctx.tx, {
            orgId: ctx.organizationId,
            branch: input.branch,
            tierId: next.tierId,
            inletMeterId: next.inletMeterId,
            boundaryValveIds: valveIds,
            ring: next.boundary,
          });
          await writeBoundaryValves(ctx.tx, ctx.organizationId, next.versionId, valveIds);
          return (await present(ctx.tx, [next]))[0]!;
        });
      }),

    delete: p.remove
      .input(z.object({ id: EntityId, baseVersionId: VersionId, branch: BranchSchema.default(MAIN) }))
      .mutation(async ({ ctx, input }) =>
        guarded(async () => {
          await assertBranchWritable(ctx, input.branch);
          // A tombstone is a version with no valve rows: a deleted DMA has no boundary.
          await editVersioned(ctx.tx, dma, {
            orgId: ctx.organizationId,
            userId: ctx.session.user.id,
            id: input.id,
            branch: input.branch,
            baseVersionId: input.baseVersionId,
            tombstone: true,
            entity: "DMA",
            patch: {},
          });
          return { ok: true as const };
        }),
      ),
  });
}
