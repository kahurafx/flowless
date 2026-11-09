import { chargeItem, chargeItemAmount } from "@flowless/db/schema/tariffs";
import { CHARGE_RECURRENCES, CHARGE_TYPES, revenueKindOf } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { isUniqueViolation } from "../../kernel/pg-errors";
import { CODE } from "./categories";
import { isoDateSchema, versionInForce, versionSpans } from "./dating";
import { chargeItemAmountChanged, chargeItemCreated } from "./events";
import type { TariffsProcedures } from "./procedures";
import {
  amountsOf,
  chooseEffectiveDate,
  findChargeItem,
  organizationToday,
  plain,
  tidy,
  toAmountDto,
  toChargeItemDto,
  type ChargeItemRow,
  type WriteContext,
} from "./service";

const Name = z.string().trim().min(1).max(120);
const Amount = z.bigint().min(0n).max(10n ** 12n);

async function present(ctx: { tx: WriteContext["tx"] }, rows: readonly ChargeItemRow[]) {
  const today = await organizationToday(ctx.tx);
  const amounts = await amountsOf(
    ctx.tx,
    rows.map((r) => r.id),
  );
  return rows.map((row) =>
    toChargeItemDto(
      row,
      amounts.filter((a) => a.chargeItemId === row.id),
      today,
    ),
  );
}

/** Appends an amount version to an item (T-07, T-03) and publishes the change. */
async function appendAmount(ctx: WriteContext, item: ChargeItemRow, input: { amount: bigint; effectiveFrom?: string | undefined; reason?: string | undefined }) {
  if (item.type === "usage") throw new TRPCError({ code: "BAD_REQUEST", message: "A usage item is priced by a tariff, not by an amount" });
  const history = await amountsOf(ctx.tx, [item.id]);
  const effectiveFrom = await chooseEffectiveDate(ctx.tx, ctx.organizationId, { requested: input.effectiveFrom, existing: history.map((a) => a.effectiveFrom), first: history.length === 0 });
  const previous = versionInForce(history, effectiveFrom);
  const versionNo = history.reduce((max, a) => Math.max(max, a.versionNo), 0) + 1;
  const [row] = await ctx.tx
    .insert(chargeItemAmount)
    .values({ organizationId: ctx.organizationId, chargeItemId: item.id, versionNo, effectiveFrom, amount: input.amount, reason: input.reason || null, createdByUserId: ctx.session.user.id })
    .returning();
  await ctx.audit({
    action: "tariffs.charge_item_amount_add",
    subjectType: "charge_item",
    subjectId: item.id,
    before: plain(previous ? { versionNo: previous.versionNo, effectiveFrom: previous.effectiveFrom, amount: previous.amount } : null),
    after: plain({ versionNo, effectiveFrom, amount: input.amount }),
    reason: input.reason || null,
  });
  await ctx.publish(chargeItemAmountChanged, {
    chargeItemId: item.id,
    code: item.code,
    versionNo,
    effectiveFrom,
    amount: input.amount.toString(),
    previousAmount: previous ? previous.amount.toString() : null,
    createdByUserId: ctx.session.user.id,
  });
  return toAmountDto(row!, null);
}

/** The charge catalog (T-07): `tariffs.chargeItems.*`. */
export function chargeItemsRouter(p: TariffsProcedures) {
  return {
    list: p.read.input(z.object({ type: z.enum(CHARGE_TYPES).optional(), active: z.boolean().optional() }).optional()).query(async ({ ctx, input }) => {
      const rows = await ctx.tx.select().from(chargeItem).orderBy(asc(chargeItem.name));
      return present(
        ctx,
        rows.filter((r) => (!input?.type || r.type === input.type) && (input?.active === undefined || r.active === input.active)),
      );
    }),

    /** An item with every amount version, oldest first. */
    get: p.read.input(z.union([z.object({ id: z.uuid() }), z.object({ code: CODE })])).query(async ({ ctx, input }) => {
      const row = await findChargeItem(ctx.tx, input);
      const [view] = await present(ctx, [row]);
      const spans = versionSpans(await amountsOf(ctx.tx, [row.id]));
      return { ...view!, amounts: spans.map((s) => toAmountDto(s.version, s.until)) };
    }),

    /**
     * Adds an item. `code` and `type` never change. A recurring item recurs monthly unless
     * told otherwise; no other type has a recurrence. `amount` (not for usage, which a
     * tariff prices) becomes the first amount version, effective today unless dated.
     */
    create: p.manage
      .input(
        z.object({
          code: CODE,
          name: Name,
          type: z.enum(CHARGE_TYPES),
          recurrence: z.enum(CHARGE_RECURRENCES).optional(),
          inventoryItemRef: z.uuid().optional(),
          amount: Amount.optional(),
          effectiveFrom: isoDateSchema.optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (input.type !== "recurring" && input.recurrence) throw new TRPCError({ code: "BAD_REQUEST", message: "Only a recurring item has a recurrence" });
        if (input.type === "usage" && input.amount !== undefined) throw new TRPCError({ code: "BAD_REQUEST", message: "A usage item is priced by a tariff, not by an amount" });
        const [row] = await ctx.tx
          .insert(chargeItem)
          .values({
            organizationId: ctx.organizationId,
            code: input.code,
            name: tidy(input.name),
            type: input.type,
            recurrence: input.type === "recurring" ? (input.recurrence ?? "monthly") : null,
            inventoryItemRef: input.inventoryItemRef ?? null,
            createdByUserId: ctx.session.user.id,
          })
          .returning()
          .catch((error: unknown) => {
            if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: `A charge item with code "${input.code}" already exists` });
            throw error;
          });
        await ctx.audit({
          action: "tariffs.charge_item_create",
          subjectType: "charge_item",
          subjectId: row!.id,
          after: { code: row!.code, name: row!.name, type: row!.type, recurrence: row!.recurrence, inventoryItemRef: row!.inventoryItemRef },
        });
        await ctx.publish(chargeItemCreated, { chargeItemId: row!.id, code: row!.code, type: row!.type, revenueKind: revenueKindOf(row!.type), createdByUserId: ctx.session.user.id });
        if (input.amount !== undefined) await appendAmount(ctx, row!, { amount: input.amount, effectiveFrom: input.effectiveFrom });
        return (await present(ctx, [row!]))[0]!;
      }),

    /** Renames an item, changes its recurrence (recurring items only) or its inventory link (`null` unlinks). */
    update: p.manage
      .input(z.object({ id: z.uuid(), name: Name.optional(), recurrence: z.enum(CHARGE_RECURRENCES).optional(), inventoryItemRef: z.uuid().nullable().optional() }))
      .mutation(async ({ ctx, input }) => {
        const before = await findChargeItem(ctx.tx, { id: input.id }, true);
        if (input.recurrence && before.type !== "recurring") throw new TRPCError({ code: "BAD_REQUEST", message: "Only a recurring item has a recurrence" });
        const patch = {
          ...(input.name !== undefined ? { name: tidy(input.name) } : {}),
          ...(input.recurrence !== undefined ? { recurrence: input.recurrence } : {}),
          ...(input.inventoryItemRef !== undefined ? { inventoryItemRef: input.inventoryItemRef } : {}),
        };
        const changed = (Object.keys(patch) as (keyof typeof patch)[]).some((k) => patch[k] !== before[k]);
        if (!changed) return (await present(ctx, [before]))[0]!;
        const [row] = await ctx.tx
          .update(chargeItem)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(chargeItem.id, before.id))
          .returning();
        const view = (r: ChargeItemRow) => ({ name: r.name, recurrence: r.recurrence, inventoryItemRef: r.inventoryItemRef });
        await ctx.audit({ action: "tariffs.charge_item_update", subjectType: "charge_item", subjectId: before.id, before: view(before), after: view(row!) });
        return (await present(ctx, [row!]))[0]!;
      }),

    /**
     * A new amount from a date (T-07, T-03): never an edit. Dated like a tariff version
     * (the next period start unless given; not inside a closed period).
     */
    addAmountVersion: p.manage
      .input(z.object({ chargeItemId: z.uuid(), amount: Amount, effectiveFrom: isoDateSchema.optional(), reason: z.string().trim().max(500).optional() }))
      .mutation(async ({ ctx, input }) => appendAmount(ctx, await findChargeItem(ctx.tx, { id: input.chargeItemId }, true), input)),

    /** Takes an item out of use for new invoices. Its history, and invoices already issued, are untouched. */
    deactivate: p.manage.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => setActive(ctx, input.id, false)),
    reactivate: p.manage.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => setActive(ctx, input.id, true)),
  };
}

async function setActive(ctx: WriteContext, id: string, active: boolean) {
  const before = await findChargeItem(ctx.tx, { id }, true);
  if (before.active === active) return (await present(ctx, [before]))[0]!;
  const [row] = await ctx.tx.update(chargeItem).set({ active, updatedAt: new Date() }).where(eq(chargeItem.id, id)).returning();
  await ctx.audit({ action: active ? "tariffs.charge_item_reactivate" : "tariffs.charge_item_deactivate", subjectType: "charge_item", subjectId: id, before: { active: before.active }, after: { active } });
  return (await present(ctx, [row!]))[0]!;
}
