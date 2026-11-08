import type { Transaction } from "@flowless/db";
import { node, subnetwork, tier } from "@flowless/db/schema/gis";
import { traceSubnetworkMembership } from "@flowless/network";
import { TRPCError } from "@trpc/server";
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { router } from "../../trpc";
import { BranchSchema, compact, EntityId, guarded, MAIN, nonEmpty } from "./common";
import { loadNetwork, toNodeRef } from "./network-view";
import type { GisProcedures } from "./procedures";
import { listEffective } from "./versioning/engine";

type SubnetworkRow = typeof subnetwork.$inferSelect;

export const toSubnetworkDto = (row: SubnetworkRow) => ({
  id: row.id,
  name: row.name,
  tierId: row.tierId,
  controllerNodeId: row.controllerNodeId,
  lastValidatedAt: row.lastValidatedAt,
});

const NameInput = z.string().trim().min(1).max(200);

/** What can anchor a subnetwork: something that supplies water or can shut it off. */
const CONTROLLER_TYPES: readonly string[] = ["reservoir", "pumping_station", "valve", "meter"];

/*
 * Subnetworks aren't versioned (administrative configuration, not field edits), so they
 * exist on main only, and a controller has to be a node that's live on MAIN.
 */
async function assertController(tx: Transaction, orgId: string, nodeId: string) {
  const [found] = await listEffective(tx, node, { orgId, branch: MAIN, where: inArray(node.id, [nodeId]) });
  if (!found) throw new TRPCError({ code: "BAD_REQUEST", message: "The controller must be an existing node on main" });
  if (!CONTROLLER_TYPES.includes(found.type)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `A ${found.type.replace("_", " ")} can't control a subnetwork: use a reservoir, pumping station, valve or meter`,
    });
  }
}

async function assertTier(tx: Transaction, tierId: string) {
  const [found] = await tx.select({ id: tier.id }).from(tier).where(eq(tier.id, tierId)).limit(1);
  if (!found) throw new TRPCError({ code: "BAD_REQUEST", message: "That tier doesn't exist in this organization" });
}

/**
 * A node can't be deleted while it controls a subnetwork. Subnetworks live on main only, so
 * this applies on every branch. Called by `nodes.delete`.
 */
export async function assertNodeNotController(tx: Transaction, nodeId: string) {
  const controlled = await tx.select({ id: subnetwork.id }).from(subnetwork).where(eq(subnetwork.controllerNodeId, nodeId));
  if (controlled.length > 0) {
    const one = controlled.length === 1;
    throw new TRPCError({ code: "CONFLICT", message: `This node controls ${controlled.length} subnetwork${one ? "" : "s"}: reassign ${one ? "it" : "them"} first` });
  }
}

async function loadSubnetwork(tx: Transaction, id: string): Promise<SubnetworkRow> {
  const [row] = await tx.select().from(subnetwork).where(eq(subnetwork.id, id)).limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Subnetwork not found" });
  return row;
}

/** Subnetworks (G-03): setup needs `gis:configure` and is audited; membership is traced live, never stored. */
export function subnetworksRouter(p: GisProcedures) {
  return router({
    list: p.read.query(async ({ ctx }) => (await ctx.tx.select().from(subnetwork).orderBy(asc(subnetwork.name))).map(toSubnetworkDto)),

    byId: p.read.input(z.object({ id: EntityId })).query(async ({ ctx, input }) => toSubnetworkDto(await loadSubnetwork(ctx.tx, input.id))),

    create: p.configure.input(z.object({ name: NameInput, tierId: EntityId, controllerNodeId: EntityId })).mutation(async ({ ctx, input }) =>
      guarded(async () => {
        await assertTier(ctx.tx, input.tierId);
        await assertController(ctx.tx, ctx.organizationId, input.controllerNodeId);
        const [row] = await ctx.tx
          .insert(subnetwork)
          .values({ organizationId: ctx.organizationId, name: input.name, tierId: input.tierId, controllerNodeId: input.controllerNodeId })
          .returning();
        await ctx.audit({ action: "gis.subnetwork.create", subjectType: "gis_subnetwork", subjectId: row!.id, after: toSubnetworkDto(row!) });
        return toSubnetworkDto(row!);
      }),
    ),

    /** Re-pointing a subnetwork (controller or tier) clears its validation; renaming leaves it alone. */
    update: p.configure
      .input(
        z.object({
          id: EntityId,
          patch: z.object({ name: NameInput, tierId: EntityId, controllerNodeId: EntityId }).partial().refine(nonEmpty, "Patch is empty"),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const { patch } = input;
        return guarded(async () => {
          const existing = await loadSubnetwork(ctx.tx, input.id);
          if (patch.tierId !== undefined) await assertTier(ctx.tx, patch.tierId);
          if (patch.controllerNodeId !== undefined) await assertController(ctx.tx, ctx.organizationId, patch.controllerNodeId);
          const repointed =
            (patch.tierId !== undefined && patch.tierId !== existing.tierId) || (patch.controllerNodeId !== undefined && patch.controllerNodeId !== existing.controllerNodeId);
          const [row] = await ctx.tx
            .update(subnetwork)
            .set({ ...compact({ name: patch.name, tierId: patch.tierId, controllerNodeId: patch.controllerNodeId }), ...(repointed ? { lastValidatedAt: null } : {}) })
            .where(eq(subnetwork.id, input.id))
            .returning();
          await ctx.audit({
            action: "gis.subnetwork.update",
            subjectType: "gis_subnetwork",
            subjectId: input.id,
            before: toSubnetworkDto(existing),
            after: toSubnetworkDto(row!),
          });
          return toSubnetworkDto(row!);
        });
      }),

    delete: p.configure.input(z.object({ id: EntityId })).mutation(async ({ ctx, input }) => {
      const existing = await loadSubnetwork(ctx.tx, input.id);
      await ctx.tx.delete(subnetwork).where(eq(subnetwork.id, input.id));
      await ctx.audit({ action: "gis.subnetwork.delete", subjectType: "gis_subnetwork", subjectId: input.id, before: toSubnetworkDto(existing) });
      return { ok: true as const };
    }),

    /** Everything reachable from the controller without passing a closed valve, as the given branch sees the network. */
    members: p.read.input(z.object({ id: EntityId, branch: BranchSchema.default(MAIN) })).query(async ({ ctx, input }) => {
      const row = await loadSubnetwork(ctx.tx, input.id);
      const network = await loadNetwork(ctx.tx, ctx.organizationId, input.branch);
      if (!network.nodes.some((n) => n.id === row.controllerNodeId)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "The controller isn't part of the network in this view" });
      }
      const members = traceSubnetworkMembership(row.controllerNodeId, network.nodes, network.pipes);
      return { subnetwork: toSubnetworkDto(row), members: members.map(toNodeRef) };
    }),

    /**
     * Recompute the membership on main and stamp the subnetwork as validated. Reports, without
     * blocking, other subnetworks in the same tier that share nodes with this one. A stamp
     * means "checked then", not "still true now".
     */
    validate: p.configure.input(z.object({ id: EntityId })).mutation(async ({ ctx, input }) => {
      const row = await loadSubnetwork(ctx.tx, input.id);
      await assertController(ctx.tx, ctx.organizationId, row.controllerNodeId);
      const network = await loadNetwork(ctx.tx, ctx.organizationId, MAIN);
      const members = new Set(traceSubnetworkMembership(row.controllerNodeId, network.nodes, network.pipes).map((n) => n.id));
      const siblings = await ctx.tx.select().from(subnetwork).where(eq(subnetwork.tierId, row.tierId));
      const overlaps = siblings
        .filter((other) => other.id !== row.id)
        .map((other) => {
          const theirs = traceSubnetworkMembership(other.controllerNodeId, network.nodes, network.pipes);
          return { subnetworkId: other.id, name: other.name, sharedNodes: theirs.filter((n) => members.has(n.id)).length };
        })
        .filter((overlap) => overlap.sharedNodes > 0);
      const [updated] = await ctx.tx.update(subnetwork).set({ lastValidatedAt: new Date() }).where(eq(subnetwork.id, input.id)).returning();
      await ctx.audit({ action: "gis.subnetwork.validate", subjectType: "gis_subnetwork", subjectId: input.id, after: { memberCount: members.size, overlaps: overlaps.length } });
      return { subnetwork: toSubnetworkDto(updated!), memberCount: members.size, overlaps };
    }),
  });
}
