import type { Transaction } from "@flowless/db";
import { workLevel } from "@flowless/shared-types";
import { crew, crewMember } from "@flowless/db/schema/work-orders";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import type { WorkRegistry } from "../../kernel/work";
import { moduleProcedure } from "../../trpc";
import { abilitiesOf, actsOnJobs, seesJobs, visibilityFor } from "./access";

/**
 * The Work Orders procedures (K-04, NF-03). The router answers while Work Orders OR GIS is
 * licensed: GIS alone gives level basic (its own kinds, no crews or SLA), Work Orders gives
 * full. The level comes from the licensed modules on every call, never from the client.
 * Members with no work-order permission are turned away, as Majimap's viewers were.
 *
 * `ctx.visibility` is what the caller may see (their own and their crews' jobs, and with
 * `work_orders:read` everything in their scope); queries must apply it.
 */
export function workOrderProcedures(work: WorkRegistry) {
  const base = moduleProcedure(["work-orders", "gis"]).use(async ({ ctx, next }) => {
    const licensed = await ctx.entitlements();
    const level = workLevel(licensed);
    const abilities = abilitiesOf(ctx.permissions);
    if (!seesJobs(abilities)) throw new TRPCError({ code: "FORBIDDEN", message: "Your permissions don't include work orders" });
    const userId = ctx.session.user.id;
    const crewIds = level === "full" ? await crewIdsOf(ctx.tx, userId) : [];
    const visibility = visibilityFor(
      abilities,
      userId,
      crewIds,
      await ctx.scope(),
    );
    return next({ ctx: { work, level, licensed, abilities, visibility } });
  });

  /** Carrying out jobs: Majimap's "act" roles, `work_orders:execute` or a manager's `work_orders:assign`. */
  const acting = base.use(({ ctx, next }) => {
    if (!actsOnJobs(ctx.abilities)) throw new TRPCError({ code: "FORBIDDEN", message: "Missing permission: work_orders:execute" });
    return next();
  });

  /** Features that need the Work Orders module itself (crews, scheduling, SLA). */
  const full = base.use(({ ctx, next }) => {
    if (ctx.level !== "full") throw new TRPCError({ code: "NOT_FOUND", message: "This needs the Work Orders module" });
    return next();
  });

  return { base, acting, full };
}

/** The live crews a member belongs to. */
export async function crewIdsOf(tx: Transaction, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: crewMember.crewId })
    .from(crewMember)
    .innerJoin(crew, and(eq(crew.organizationId, crewMember.organizationId), eq(crew.id, crewMember.crewId)))
    .where(and(eq(crewMember.userId, userId), isNull(crew.archivedAt)));
  return rows.map((r) => r.id);
}

export function need(has: boolean, permission: string) {
  if (!has) throw new TRPCError({ code: "FORBIDDEN", message: `Missing permission: ${permission}` });
}
