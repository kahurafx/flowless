import type { Transaction } from "@flowless/db";
import { crew, crewMember } from "@flowless/db/schema/work-orders";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { isForeignKeyViolation, isUniqueViolation } from "../../kernel/pg-errors";
import { router } from "../../trpc";
import { need, type workOrderProcedures } from "./procedures";

const Name = z.string().trim().min(1).max(100);

/**
 * Crews (W-02, Work Orders module): who works together. Anyone who sees jobs lists them;
 * changing them needs `work_orders:assign`. Archived, never deleted, because jobs keep
 * pointing at them. A crew's members see and work its jobs.
 */
export function crewsRouter(p: ReturnType<typeof workOrderProcedures>) {
  const manage = p.full.use(({ ctx, next }) => {
    need(ctx.abilities.assign, "work_orders:assign");
    return next();
  });

  async function find(tx: Transaction, id: string) {
    const [row] = await tx.select().from(crew).where(eq(crew.id, id));
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Crew not found" });
    return row;
  }
  const taken = (error: unknown): never => {
    if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: "A crew with that name already exists" });
    throw error;
  };

  return router({
    list: p.full.input(z.object({ includeArchived: z.boolean().default(false) }).optional()).query(async ({ ctx, input }) => {
      const crews = await ctx.tx
        .select()
        .from(crew)
        .where(input?.includeArchived ? undefined : isNull(crew.archivedAt))
        .orderBy(asc(crew.name));
      const members = crews.length
        ? await ctx.tx
            .select()
            .from(crewMember)
            .where(inArray(crewMember.crewId, crews.map((c) => c.id)))
        : [];
      return crews.map((c) => ({
        id: c.id,
        name: c.name,
        createdAt: c.createdAt,
        archivedAt: c.archivedAt,
        memberUserIds: members.filter((m) => m.crewId === c.id).map((m) => m.userId),
      }));
    }),

    create: manage.input(z.object({ name: Name })).mutation(async ({ ctx, input }) => {
      const [row] = await ctx.tx
        .insert(crew)
        .values({ organizationId: ctx.organizationId, name: input.name })
        .returning()
        .catch(taken);
      await ctx.audit({ action: "work_orders.crew_create", subjectType: "crew", subjectId: row!.id, after: { name: row!.name } });
      return row!;
    }),

    rename: manage.input(z.object({ id: z.uuid(), name: Name })).mutation(async ({ ctx, input }) => {
      const before = await find(ctx.tx, input.id);
      if (before.name === input.name) return before;
      const [row] = await ctx.tx.update(crew).set({ name: input.name }).where(eq(crew.id, before.id)).returning().catch(taken);
      await ctx.audit({ action: "work_orders.crew_rename", subjectType: "crew", subjectId: before.id, before: { name: before.name }, after: { name: input.name } });
      return row!;
    }),

    archive: manage.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
      const before = await find(ctx.tx, input.id);
      if (before.archivedAt) return before;
      const [row] = await ctx.tx.update(crew).set({ archivedAt: new Date() }).where(eq(crew.id, before.id)).returning();
      await ctx.audit({ action: "work_orders.crew_archive", subjectType: "crew", subjectId: before.id, before: { archivedAt: null }, after: { archivedAt: row!.archivedAt } });
      return row!;
    }),

    addMember: manage.input(z.object({ crewId: z.uuid(), userId: z.uuid() })).mutation(async ({ ctx, input }) => {
      const team = await find(ctx.tx, input.crewId);
      if (team.archivedAt) throw new TRPCError({ code: "CONFLICT", message: "This crew is archived" });
      try {
        const added = await ctx.tx
          .transaction((sp) =>
            sp
              .insert(crewMember)
              .values({ organizationId: ctx.organizationId, crewId: team.id, userId: input.userId })
              .onConflictDoNothing()
              .returning({ userId: crewMember.userId }),
          );
        if (added.length) await ctx.audit({ action: "work_orders.crew_add_member", subjectType: "crew", subjectId: team.id, after: { userId: input.userId } });
      } catch (error) {
        if (isForeignKeyViolation(error)) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
        throw error;
      }
    }),

    removeMember: manage.input(z.object({ crewId: z.uuid(), userId: z.uuid() })).mutation(async ({ ctx, input }) => {
      const team = await find(ctx.tx, input.crewId);
      const removed = await ctx.tx
        .delete(crewMember)
        .where(and(eq(crewMember.crewId, team.id), eq(crewMember.userId, input.userId)))
        .returning({ userId: crewMember.userId });
      if (removed.length) await ctx.audit({ action: "work_orders.crew_remove_member", subjectType: "crew", subjectId: team.id, before: { userId: input.userId } });
    }),
  });
}
