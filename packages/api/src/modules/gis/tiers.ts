import type { Transaction } from "@flowless/db";
import { dma, subnetwork, tier } from "@flowless/db/schema/gis";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { router } from "../../trpc";
import { compact, EntityId, guarded, nonEmpty } from "./common";
import type { GisProcedures } from "./procedures";

type TierRow = typeof tier.$inferSelect;

export const toTierDto = (row: TierRow) => ({ id: row.id, name: row.name, order: row.order });

const NameInput = z.string().trim().min(1).max(100);
/** 1 is the top of the hierarchy (transmission); higher numbers sit further down. */
const OrderInput = z.number().int().min(1).max(100);

async function assertOrderFree(tx: Transaction, order: number, exceptId?: string) {
  const [clash] = await tx
    .select({ id: tier.id, name: tier.name })
    .from(tier)
    .where(and(eq(tier.order, order), exceptId ? ne(tier.id, exceptId) : undefined))
    .limit(1);
  if (clash) throw new TRPCError({ code: "CONFLICT", message: `The tier "${clash.name}" already uses order ${order}` });
}

async function loadTier(tx: Transaction, id: string): Promise<TierRow> {
  const [row] = await tx.select().from(tier).where(eq(tier.id, id)).limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Tier not found" });
  return row;
}

/** Network tiers (G-01): configuration, so changing them needs `gis:configure`; every change is audited. */
export function tiersRouter(p: GisProcedures) {
  return router({
    /** Top of the hierarchy first. */
    list: p.read.query(async ({ ctx }) => (await ctx.tx.select().from(tier).orderBy(asc(tier.order))).map(toTierDto)),

    create: p.configure.input(z.object({ name: NameInput, order: OrderInput })).mutation(async ({ ctx, input }) =>
      guarded(async () => {
        await assertOrderFree(ctx.tx, input.order);
        const [row] = await ctx.tx.insert(tier).values({ organizationId: ctx.organizationId, name: input.name, order: input.order }).returning();
        await ctx.audit({ action: "gis.tier.create", subjectType: "gis_tier", subjectId: row!.id, after: toTierDto(row!) });
        return toTierDto(row!);
      }),
    ),

    update: p.configure
      .input(z.object({ id: EntityId, patch: z.object({ name: NameInput, order: OrderInput }).partial().refine(nonEmpty, "Patch is empty") }))
      .mutation(async ({ ctx, input }) =>
        guarded(async () => {
          const before = await loadTier(ctx.tx, input.id);
          if (input.patch.order !== undefined) await assertOrderFree(ctx.tx, input.patch.order, input.id);
          const [row] = await ctx.tx
            .update(tier)
            .set(compact({ name: input.patch.name, order: input.patch.order }))
            .where(eq(tier.id, input.id))
            .returning();
          await ctx.audit({ action: "gis.tier.update", subjectType: "gis_tier", subjectId: input.id, before: toTierDto(before), after: toTierDto(row!) });
          return toTierDto(row!);
        }),
      ),

    /**
     * A tier that anything has ever pointed at can't be deleted, only renamed or re-ordered:
     * live subnetworks and DMAs would be left dangling, and DMA versions are history.
     */
    delete: p.configure.input(z.object({ id: EntityId })).mutation(async ({ ctx, input }) =>
      guarded(async () => {
        const before = await loadTier(ctx.tx, input.id);
        const usingSubnetworks = await ctx.tx.select({ id: subnetwork.id }).from(subnetwork).where(eq(subnetwork.tierId, input.id));
        if (usingSubnetworks.length > 0) {
          const one = usingSubnetworks.length === 1;
          throw new TRPCError({ code: "CONFLICT", message: `${usingSubnetworks.length} subnetwork${one ? " uses" : "s use"} this tier: move ${one ? "it" : "them"} first` });
        }
        const usingDmas = await ctx.tx.select({ isHead: dma.isHead, isDeleted: dma.isDeleted }).from(dma).where(eq(dma.tierId, input.id));
        const live = usingDmas.filter((d) => d.isHead && !d.isDeleted).length;
        if (live > 0) throw new TRPCError({ code: "CONFLICT", message: `${live} DMA${live === 1 ? " uses" : "s use"} this tier: move ${live === 1 ? "it" : "them"} first` });
        if (usingDmas.length > 0) {
          throw new TRPCError({ code: "CONFLICT", message: "Past versions of DMAs refer to this tier, so it can't be deleted: rename it instead" });
        }
        await ctx.tx.delete(tier).where(eq(tier.id, input.id));
        await ctx.audit({ action: "gis.tier.delete", subjectType: "gis_tier", subjectId: input.id, before: toTierDto(before) });
        return { ok: true as const };
      }),
    ),
  });
}
