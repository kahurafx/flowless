import { category, categoryAssignment } from "@flowless/db/schema/tariffs";
import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { isUniqueViolation } from "../../kernel/pg-errors";
import { isoDateSchema, versionInForce } from "./dating";
import type { TariffsProcedures } from "./procedures";
import { plain, tidy } from "../../kernel/text";
import {
  assignmentsOf,
  chooseEffectiveDate,
  findCategory,
  findChargeItem,
  findTariff,
  organizationToday,
  toAssignmentDto,
  toCategoryDto,
  type CategoryRow,
  type WriteContext,
} from "./service";

export const CODE = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "Use lower-case letters, digits and underscores, starting with a letter");
const Name = z.string().trim().min(1).max(120);

async function present(ctx: { tx: WriteContext["tx"] }, rows: readonly CategoryRow[]) {
  const today = await organizationToday(ctx.tx);
  const assignments = await assignmentsOf(
    ctx.tx,
    rows.map((r) => r.id),
  );
  return rows.map((row) => {
    const mine = assignments.filter((a) => a.categoryId === row.id);
    const current = versionInForce(mine, today);
    return {
      ...toCategoryDto(row),
      /** What the category is priced with today: tariff, standing charge, meter rent, discount. */
      current: current ? toAssignmentDto(current) : null,
      /** Changes that start after today. */
      upcoming: mine.filter((a) => a.effectiveFrom > today && a.id !== current?.id).map(toAssignmentDto),
    };
  });
}

/** The reference ids one assignment may point at, checked for kind: a standing charge and meter rent are recurring items, a discount an adjustment. */
async function checkReferences(ctx: WriteContext, refs: { tariffId: string | null; standingChargeItemId: string | null; meterRentItemId: string | null; discountItemId: string | null }) {
  if (refs.tariffId) {
    const t = await findTariff(ctx.tx, refs.tariffId);
    if (!t.active) throw new TRPCError({ code: "BAD_REQUEST", message: `Tariff "${t.name}" is not active` });
  }
  const item = async (id: string | null, type: "recurring" | "adjustment", what: string) => {
    if (!id) return;
    const row = await findChargeItem(ctx.tx, { id });
    if (row.type !== type) throw new TRPCError({ code: "BAD_REQUEST", message: `${what} must be a ${type} charge item; "${row.code}" is ${row.type}` });
    if (!row.active) throw new TRPCError({ code: "BAD_REQUEST", message: `Charge item "${row.code}" is not active` });
  };
  await item(refs.standingChargeItemId, "recurring", "A standing charge");
  await item(refs.meterRentItemId, "recurring", "Meter rent");
  await item(refs.discountItemId, "adjustment", "A discount");
}

/** Customer categories (T-02): `tariffs.categories.*`. */
export function categoriesRouter(p: TariffsProcedures) {
  return {
    list: p.read.input(z.object({ includeInactive: z.boolean().default(false) }).optional()).query(async ({ ctx, input }) => {
      const rows = await ctx.tx.select().from(category).orderBy(asc(category.name));
      return present(ctx, input?.includeInactive ? rows : rows.filter((r) => r.active));
    }),

    /** A category with its whole pricing history, oldest first. */
    get: p.read.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
      const row = await findCategory(ctx.tx, input.id);
      const [view] = await present(ctx, [row]);
      return { ...view!, history: (await assignmentsOf(ctx.tx, [row.id])).map(toAssignmentDto) };
    }),

    create: p.manage.input(z.object({ code: CODE, name: Name })).mutation(async ({ ctx, input }) => {
      const [row] = await ctx.tx
        .insert(category)
        .values({ organizationId: ctx.organizationId, code: input.code, name: tidy(input.name), createdByUserId: ctx.session.user.id })
        .returning()
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: `A category with code "${input.code}" already exists` });
          throw error;
        });
      await ctx.audit({ action: "tariffs.category_create", subjectType: "category", subjectId: row!.id, after: { code: row!.code, name: row!.name } });
      return (await present(ctx, [row!]))[0]!;
    }),

    /** Renames a category. Its code never changes. */
    update: p.manage.input(z.object({ id: z.uuid(), name: Name })).mutation(async ({ ctx, input }) => {
      const before = await findCategory(ctx.tx, input.id, true);
      const name = tidy(input.name);
      if (name === before.name) return (await present(ctx, [before]))[0]!;
      const [row] = await ctx.tx.update(category).set({ name, updatedAt: new Date() }).where(eq(category.id, before.id)).returning();
      await ctx.audit({ action: "tariffs.category_update", subjectType: "category", subjectId: before.id, before: { name: before.name }, after: { name: row!.name } });
      return (await present(ctx, [row!]))[0]!;
    }),

    /** Stops a category being chosen for new accounts. Accounts that have it keep it, and its pricing history stays. */
    deactivate: p.manage.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => setActive(ctx, input.id, false)),
    reactivate: p.manage.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => setActive(ctx, input.id, true)),

    /**
     * Points a category at a tariff, standing charge, meter rent and discount from a date
     * (T-02, T-03). Insert-only: it adds an assignment, so which tariff a category used
     * is known for any past date. Anything left out keeps the value in force on that date;
     * `null` clears it. Dated like a tariff version: the next period start unless given.
     */
    assignTariff: p.manage
      .input(
        z.object({
          categoryId: z.uuid(),
          tariffId: z.uuid().nullable().optional(),
          standingChargeItemId: z.uuid().nullable().optional(),
          meterRentItemId: z.uuid().nullable().optional(),
          discountItemId: z.uuid().nullable().optional(),
          effectiveFrom: isoDateSchema.optional(),
          reason: z.string().trim().max(500).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const cat = await findCategory(ctx.tx, input.categoryId, true);
        const history = await assignmentsOf(ctx.tx, [cat.id]);
        const effectiveFrom = await chooseEffectiveDate(ctx.tx, ctx.organizationId, {
          requested: input.effectiveFrom,
          existing: history.map((a) => a.effectiveFrom),
          first: history.length === 0,
        });
        const base = versionInForce(history, effectiveFrom);
        const pick = <K extends "tariffId" | "standingChargeItemId" | "meterRentItemId" | "discountItemId">(key: K): string | null => (input[key] !== undefined ? input[key] : (base?.[key] ?? null));
        const refs = { tariffId: pick("tariffId"), standingChargeItemId: pick("standingChargeItemId"), meterRentItemId: pick("meterRentItemId"), discountItemId: pick("discountItemId") };
        await checkReferences(ctx, refs);
        const versionNo = history.reduce((max, a) => Math.max(max, a.versionNo), 0) + 1;
        const [row] = await ctx.tx
          .insert(categoryAssignment)
          .values({ organizationId: ctx.organizationId, categoryId: cat.id, versionNo, effectiveFrom, ...refs, reason: input.reason || null, createdByUserId: ctx.session.user.id })
          .returning();
        await ctx.audit({
          action: "tariffs.category_assign",
          subjectType: "category",
          subjectId: cat.id,
          before: plain(base ? toAssignmentDto(base) : null),
          after: plain(toAssignmentDto(row!)),
          reason: input.reason || null,
        });
        return toAssignmentDto(row!);
      }),
  };
}

async function setActive(ctx: WriteContext, id: string, active: boolean) {
  const before = await findCategory(ctx.tx, id, true);
  if (before.active === active) return toCategoryDto(before);
  const [row] = await ctx.tx.update(category).set({ active, updatedAt: new Date() }).where(eq(category.id, id)).returning();
  await ctx.audit({ action: active ? "tariffs.category_reactivate" : "tariffs.category_deactivate", subjectType: "category", subjectId: id, before: { active: before.active }, after: { active } });
  return toCategoryDto(row!);
}
