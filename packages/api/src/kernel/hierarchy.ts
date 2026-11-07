import { area, route, type Transaction } from "@flowless/db";
import { AREA_LEVELS, areaParentProblem, type Area, type AreaLevel, type Route } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { permittedProcedure, router, tenantProcedure } from "../trpc";
import { isForeignKeyViolation, isUniqueViolation } from "./pg-errors";
import { descendantsOf } from "./scope";

const code = z.string().trim().min(1).max(32);
const name = z.string().trim().min(1).max(120);
const listInput = z.object({ includeArchived: z.boolean().default(false) }).default({ includeArchived: false });

const areaColumns = {
  id: area.id,
  level: area.level,
  code: area.code,
  name: area.name,
  parentId: area.parentId,
  archivedAt: area.archivedAt,
};
const routeColumns = {
  id: route.id,
  code: route.code,
  name: route.name,
  parentId: route.parentId,
  areaId: route.areaId,
  archivedAt: route.archivedAt,
};

/** Maps constraint errors to messages the person can act on. */
async function write<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: `That ${what} code is already used` });
    if (isForeignKeyViolation(error)) throw new TRPCError({ code: "NOT_FOUND", message: "Parent or area not found" });
    throw error;
  }
}

async function findArea(tx: Transaction, id: string) {
  const [row] = await tx.select(areaColumns).from(area).where(eq(area.id, id));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Area not found" });
  return row;
}

async function findRoute(tx: Transaction, id: string) {
  const [row] = await tx.select(routeColumns).from(route).where(eq(route.id, id));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Route not found" });
  return row;
}

/** The parent must exist here, be active, sit at a higher level, and not be the area itself or below it. */
async function checkAreaParent(tx: Transaction, level: AreaLevel, parentId: string | null, selfId?: string) {
  const parent = parentId ? await findArea(tx, parentId) : null;
  if (parent?.archivedAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The parent is archived" });
  const problem = areaParentProblem(level, parent?.level ?? null);
  if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem });
  if (selfId && parentId && (await descendantsOf(tx, "area", selfId)).has(parentId)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "An area cannot sit under itself or one of its own areas" });
  }
}

async function checkRouteParent(tx: Transaction, parentId: string | null, selfId?: string) {
  if (!parentId) return;
  const parent = await findRoute(tx, parentId);
  if (parent.archivedAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The route group is archived" });
  if (selfId && (await descendantsOf(tx, "route", selfId)).has(parentId)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A route cannot sit under itself or one of its own routes" });
  }
}

/** Organization hierarchy and routes (K-02). Everyone reads; changing them needs `settings:manage`. */
export const hierarchyRouter = router({
  areas: tenantProcedure.input(listInput).query(
    ({ ctx, input }): Promise<Area[]> =>
      ctx.tx
        .select(areaColumns)
        .from(area)
        .where(input.includeArchived ? undefined : isNull(area.archivedAt))
        .orderBy(asc(area.level), asc(area.code)),
  ),

  createArea: permittedProcedure("settings:manage")
    .input(z.object({ level: z.enum(AREA_LEVELS), code, name, parentId: z.uuid().nullable().default(null) }))
    .mutation(async ({ ctx, input }) => {
      await checkAreaParent(ctx.tx, input.level, input.parentId);
      const [created] = await write("area", () =>
        ctx.tx
          .insert(area)
          .values({ ...input, organizationId: ctx.organizationId })
          .returning(areaColumns),
      );
      await ctx.audit({ action: "hierarchy.create_area", subjectType: "area", subjectId: created!.id, after: created });
      return created!;
    }),

  /** Renames, recodes or moves an area. Its level never changes: accounts and reports key on it. */
  updateArea: permittedProcedure("settings:manage")
    .input(z.object({ id: z.uuid(), code: code.optional(), name: name.optional(), parentId: z.uuid().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const current = await findArea(ctx.tx, input.id);
      if (input.parentId !== undefined) await checkAreaParent(ctx.tx, current.level, input.parentId, current.id);
      const { id, ...changes } = input;
      const [updated] = await write("area", () =>
        ctx.tx.update(area).set(changes).where(eq(area.id, id)).returning(areaColumns),
      );
      await ctx.audit({ action: "hierarchy.update_area", subjectType: "area", subjectId: id, before: current, after: updated });
      return updated!;
    }),

  /** Archives an area with no active areas or routes below it. Reversible with `restoreArea`. */
  archiveArea: permittedProcedure("settings:manage")
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await findArea(ctx.tx, input.id);
      const [child] = await ctx.tx
        .select({ id: area.id })
        .from(area)
        .where(and(eq(area.parentId, input.id), isNull(area.archivedAt)))
        .limit(1);
      const [linked] = await ctx.tx
        .select({ id: route.id })
        .from(route)
        .where(and(eq(route.areaId, input.id), isNull(route.archivedAt)))
        .limit(1);
      if (child || linked) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Archive or move the areas and routes under it first" });
      }
      await ctx.tx.update(area).set({ archivedAt: new Date() }).where(and(eq(area.id, input.id), isNull(area.archivedAt)));
      await ctx.audit({ action: "hierarchy.archive_area", subjectType: "area", subjectId: input.id });
    }),

  restoreArea: permittedProcedure("settings:manage")
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const current = await findArea(ctx.tx, input.id);
      if (current.parentId && (await findArea(ctx.tx, current.parentId)).archivedAt) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Restore its parent first" });
      }
      await ctx.tx.update(area).set({ archivedAt: null }).where(eq(area.id, input.id));
      await ctx.audit({ action: "hierarchy.restore_area", subjectType: "area", subjectId: input.id });
    }),

  routes: tenantProcedure.input(listInput).query(
    ({ ctx, input }): Promise<Route[]> =>
      ctx.tx
        .select(routeColumns)
        .from(route)
        .where(input.includeArchived ? undefined : isNull(route.archivedAt))
        .orderBy(asc(route.code)),
  ),

  createRoute: permittedProcedure("settings:manage")
    .input(z.object({ code, name, parentId: z.uuid().nullable().default(null), areaId: z.uuid().nullable().default(null) }))
    .mutation(async ({ ctx, input }) => {
      await checkRouteParent(ctx.tx, input.parentId);
      const [created] = await write("route", () =>
        ctx.tx
          .insert(route)
          .values({ ...input, organizationId: ctx.organizationId })
          .returning(routeColumns),
      );
      await ctx.audit({ action: "hierarchy.create_route", subjectType: "route", subjectId: created!.id, after: created });
      return created!;
    }),

  updateRoute: permittedProcedure("settings:manage")
    .input(
      z.object({
        id: z.uuid(),
        code: code.optional(),
        name: name.optional(),
        parentId: z.uuid().nullable().optional(),
        areaId: z.uuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const current = await findRoute(ctx.tx, input.id);
      if (input.parentId !== undefined) await checkRouteParent(ctx.tx, input.parentId, current.id);
      const { id, ...changes } = input;
      const [updated] = await write("route", () =>
        ctx.tx.update(route).set(changes).where(eq(route.id, id)).returning(routeColumns),
      );
      await ctx.audit({ action: "hierarchy.update_route", subjectType: "route", subjectId: id, before: current, after: updated });
      return updated!;
    }),

  archiveRoute: permittedProcedure("settings:manage")
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await findRoute(ctx.tx, input.id);
      const [child] = await ctx.tx
        .select({ id: route.id })
        .from(route)
        .where(and(eq(route.parentId, input.id), isNull(route.archivedAt)))
        .limit(1);
      if (child) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Archive or move the routes under it first" });
      await ctx.tx.update(route).set({ archivedAt: new Date() }).where(and(eq(route.id, input.id), isNull(route.archivedAt)));
      await ctx.audit({ action: "hierarchy.archive_route", subjectType: "route", subjectId: input.id });
    }),

  restoreRoute: permittedProcedure("settings:manage")
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const current = await findRoute(ctx.tx, input.id);
      if (current.parentId && (await findRoute(ctx.tx, current.parentId)).archivedAt) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Restore its route group first" });
      }
      await ctx.tx.update(route).set({ archivedAt: null }).where(eq(route.id, input.id));
      await ctx.audit({ action: "hierarchy.restore_route", subjectType: "route", subjectId: input.id });
    }),
});
