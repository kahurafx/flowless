import { chargeItem, invoiceType, invoiceTypeLine, lateFeeRule } from "@flowless/db/schema/tariffs";
import { INVOICE_APPLIES_TO } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { isUniqueViolation } from "../../kernel/pg-errors";
import { CODE } from "./categories";
import { invoiceTypeChanged } from "./events";
import { invoicePolicyProblems, overdueSchema, termsSchema, type OverduePolicy, type Terms } from "./invoice-policy";
import { lateFee, lateFeeRuleSchema, type LateFeeRule } from "./late-fee";
import type { TariffsProcedures } from "./procedures";
import { findInvoiceType, lateFeeRuleOf, overdueOf, plain, presentInvoiceTypes, previewInvoiceNumber, termsOf, tidy, type InvoiceTypeDto, type InvoiceTypeRow, type WriteContext } from "./service";

const Name = z.string().trim().min(1).max(120);
const Prefix = z.string().trim().regex(/^[A-Za-z0-9/_-]{0,12}$/, "Up to 12 letters, digits, dashes, slashes or underscores");
const numberingSchema = z.object({
  prefix: Prefix.default(""),
  /** Digits the sequence is padded to ("INV-000042" is width 6). */
  width: z.number().int().min(1).max(12).default(6),
  /** The first sequence number; raising it skips ahead, lowering it never reuses numbers. */
  start: z.number().int().min(1).max(999_999_999_999).default(1),
});
const numberingPatch = z.object({ prefix: Prefix.optional(), width: z.number().int().min(1).max(12).optional(), start: z.number().int().min(1).max(999_999_999_999).optional() });
const lineSchema = z.object({
  chargeItemCode: CODE,
  quantity: z.number().int().min(1).max(1000).default(1),
  /** Overrides the catalog amount for this line; leave out to use the amount in force when invoiced. */
  amountOverride: z.bigint().min(0n).max(10n ** 12n).nullable().default(null),
  /** An optional line is offered but not required on the invoice. */
  optional: z.boolean().default(false),
});
const DueDays = z.number().int().min(0).max(365);

const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

/** The columns that hold payment terms; the fields a kind does not use are cleared. */
function termsColumns(terms: Terms) {
  return {
    termsKind: terms.kind,
    minDepositBp: terms.kind === "minimum_deposit" ? (terms.percentBp ?? null) : null,
    minDepositAmount: terms.kind === "minimum_deposit" ? (terms.amount ?? null) : null,
    installmentCount: terms.kind === "installments" ? terms.count : null,
    installmentIntervalDays: terms.kind === "installments" ? terms.intervalDays : null,
  };
}

async function reload(ctx: { tx: WriteContext["tx"] }, id: string): Promise<InvoiceTypeDto> {
  return (await presentInvoiceTypes(ctx.tx, [await findInvoiceType(ctx.tx, { id })]))[0]!;
}

async function changed(ctx: WriteContext, row: Pick<InvoiceTypeRow, "id" | "code">, change: "created" | "updated" | "lines_set" | "late_fee_rule_set") {
  await ctx.publish(invoiceTypeChanged, { invoiceTypeId: row.id, code: row.code, change, changedByUserId: ctx.session.user.id });
}

/** Replaces the line template: each code must be an active catalog item, once. Returns what was stored. */
async function writeLines(ctx: WriteContext, typeId: string, lines: readonly z.output<typeof lineSchema>[]) {
  const codes = lines.map((l) => l.chargeItemCode);
  if (new Set(codes).size !== codes.length) throw bad("A charge item can appear once in the template");
  const items = codes.length ? await ctx.tx.select({ id: chargeItem.id, code: chargeItem.code, active: chargeItem.active }).from(chargeItem).where(inArray(chargeItem.code, codes)) : [];
  for (const code of codes) {
    const item = items.find((i) => i.code === code);
    if (!item) throw bad(`There is no charge item "${code}"`);
    if (!item.active) throw bad(`Charge item "${code}" is not active`);
  }
  await ctx.tx.delete(invoiceTypeLine).where(eq(invoiceTypeLine.invoiceTypeId, typeId));
  if (lines.length) {
    await ctx.tx.insert(invoiceTypeLine).values(
      lines.map((l, position) => ({
        organizationId: ctx.organizationId,
        invoiceTypeId: typeId,
        position,
        chargeItemId: items.find((i) => i.code === l.chargeItemCode)!.id,
        quantity: l.quantity,
        amountOverride: l.amountOverride,
        optional: l.optional,
      })),
    );
  }
}

async function writeRule(ctx: WriteContext, typeId: string, rule: LateFeeRule | null) {
  if (rule === null) {
    await ctx.tx.delete(lateFeeRule).where(eq(lateFeeRule.invoiceTypeId, typeId));
    return;
  }
  const values = { triggerDays: rule.triggerDays, base: rule.base, rateBp: rule.rateBp, flatAmount: rule.flatAmount, cap: rule.cap, frequency: rule.frequency };
  await ctx.tx
    .insert(lateFeeRule)
    .values({ organizationId: ctx.organizationId, invoiceTypeId: typeId, ...values })
    .onConflictDoUpdate({ target: [lateFeeRule.organizationId, lateFeeRule.invoiceTypeId], set: { ...values, updatedAt: new Date() } });
}

/** Invoice types (T-08 to T-10): `tariffs.invoiceTypes.*`. */
export function invoiceTypesRouter(p: TariffsProcedures) {
  return {
    list: p.read.input(z.object({ appliesTo: z.enum(INVOICE_APPLIES_TO).optional(), active: z.boolean().optional() }).optional()).query(async ({ ctx, input }) => {
      const rows = await ctx.tx.select().from(invoiceType).orderBy(asc(invoiceType.name));
      return presentInvoiceTypes(
        ctx.tx,
        rows.filter((r) => (!input?.appliesTo || r.appliesTo === input.appliesTo) && (input?.active === undefined || r.active === input.active)),
      );
    }),

    /** An invoice type with its line template and late-fee rule, and the number the next invoice would get. */
    get: p.read.input(z.union([z.object({ id: z.uuid() }), z.object({ code: CODE })])).query(async ({ ctx, input }) => {
      const row = await findInvoiceType(ctx.tx, input);
      const [view] = await presentInvoiceTypes(ctx.tx, [row]);
      return { ...view!, nextNumber: await previewInvoiceNumber(ctx.tx, row) };
    }),

    /**
     * Creates an invoice type (T-08): numbering, default days to due, payment terms (T-09),
     * the overdue policy and, optionally, its line template and late-fee rule (T-10). An
     * application's invoice may pause or cancel the application when overdue and never
     * disconnect.
     */
    create: p.manage
      .input(
        z.object({
          code: CODE,
          name: Name,
          appliesTo: z.enum(INVOICE_APPLIES_TO),
          numbering: numberingSchema.default({ prefix: "", width: 6, start: 1 }),
          dueDays: DueDays.default(14),
          terms: termsSchema.default({ kind: "full" }),
          overdue: overdueSchema.default({ action: "none", afterDays: 0 }),
          lines: z.array(lineSchema).max(30).default([]),
          lateFeeRule: lateFeeRuleSchema.optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const problems = invoicePolicyProblems(input);
        if (problems.length) throw bad(problems.join("; "));
        const [row] = await ctx.tx
          .insert(invoiceType)
          .values({
            organizationId: ctx.organizationId,
            code: input.code,
            name: tidy(input.name),
            appliesTo: input.appliesTo,
            numberPrefix: input.numbering.prefix,
            numberWidth: input.numbering.width,
            numberStart: input.numbering.start,
            dueDays: input.dueDays,
            ...termsColumns(input.terms),
            overdueAction: input.overdue.action,
            overdueAfterDays: input.overdue.afterDays,
            createdByUserId: ctx.session.user.id,
          })
          .returning()
          .catch((error: unknown) => {
            if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: `An invoice type with code "${input.code}" already exists` });
            throw error;
          });
        await writeLines(ctx, row!.id, input.lines);
        if (input.lateFeeRule) await writeRule(ctx, row!.id, input.lateFeeRule);
        const view = await reload(ctx, row!.id);
        await ctx.audit({ action: "tariffs.invoice_type_create", subjectType: "invoice_type", subjectId: row!.id, after: plain(view) });
        await changed(ctx, row!, "created");
        return view;
      }),

    /** Changes the name, numbering, days to due, terms, overdue policy or active flag. `appliesTo` and `code` never change. */
    update: p.manage
      .input(
        z.object({
          id: z.uuid(),
          name: Name.optional(),
          numbering: numberingPatch.optional(),
          dueDays: DueDays.optional(),
          terms: termsSchema.optional(),
          overdue: overdueSchema.optional(),
          active: z.boolean().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const before = await findInvoiceType(ctx.tx, { id: input.id }, true);
        const terms: Terms = input.terms ?? termsOf(before);
        const overdue: OverduePolicy = input.overdue ?? overdueOf(before);
        const problems = invoicePolicyProblems({ appliesTo: before.appliesTo, terms, overdue });
        if (problems.length) throw bad(problems.join("; "));
        const prior = await reload(ctx, before.id);
        await ctx.tx
          .update(invoiceType)
          .set({
            name: input.name !== undefined ? tidy(input.name) : before.name,
            numberPrefix: input.numbering?.prefix ?? before.numberPrefix,
            numberWidth: input.numbering?.width ?? before.numberWidth,
            numberStart: input.numbering?.start ?? before.numberStart,
            dueDays: input.dueDays ?? before.dueDays,
            ...termsColumns(terms),
            overdueAction: overdue.action,
            overdueAfterDays: overdue.afterDays,
            active: input.active ?? before.active,
            updatedAt: new Date(),
          })
          .where(eq(invoiceType.id, before.id));
        const view = await reload(ctx, before.id);
        if (JSON.stringify(plain({ ...view, updatedAt: null })) === JSON.stringify(plain({ ...prior, updatedAt: null }))) return view;
        await ctx.audit({ action: "tariffs.invoice_type_update", subjectType: "invoice_type", subjectId: before.id, before: plain(prior), after: plain(view) });
        await changed(ctx, before, "updated");
        return view;
      }),

    /**
     * Replaces the line template (T-08): the charge items a new invoice of this type
     * carries, by code, in order. A new-connection invoice's defaults are application,
     * connection, meter, materials, labour and deposit.
     */
    setLines: p.manage
      .input(z.object({ id: z.uuid(), lines: z.array(lineSchema).max(30) }))
      .mutation(async ({ ctx, input }) => {
        const row = await findInvoiceType(ctx.tx, { id: input.id }, true);
        const prior = await reload(ctx, row.id);
        await writeLines(ctx, row.id, input.lines);
        const view = await reload(ctx, row.id);
        await ctx.audit({ action: "tariffs.invoice_type_lines_set", subjectType: "invoice_type", subjectId: row.id, before: plain(prior.lines), after: plain(view.lines) });
        await changed(ctx, row, "lines_set");
        return view;
      }),

    /** Sets (or, with `null`, removes) the type's late-fee rule (T-10). */
    setLateFeeRule: p.manage
      .input(z.object({ id: z.uuid(), rule: lateFeeRuleSchema.nullable() }))
      .mutation(async ({ ctx, input }) => {
        const row = await findInvoiceType(ctx.tx, { id: input.id }, true);
        const prior = await reload(ctx, row.id);
        await writeRule(ctx, row.id, input.rule);
        const view = await reload(ctx, row.id);
        await ctx.audit({ action: "tariffs.invoice_type_late_fee_rule_set", subjectType: "invoice_type", subjectId: row.id, before: plain(prior.lateFeeRule), after: plain(view.lateFeeRule) });
        await changed(ctx, row, "late_fee_rule_set");
        return view;
      }),
  };
}

/**
 * What a late-fee rule would charge (T-10), for a form before it is saved or a collector
 * looking at one invoice: either a type's saved rule or a draft rule. Nothing is written.
 */
export function simulateLateFee(p: TariffsProcedures) {
  return p.read
    .input(
      z
        .object({
          invoiceTypeId: z.uuid().optional(),
          rule: lateFeeRuleSchema.optional(),
          /** The overdue balance, in minor units. */
          balance: z.bigint().max(10n ** 15n),
          /** The invoice total, for rules based on it; defaults to the balance. */
          invoiceTotal: z.bigint().max(10n ** 15n).optional(),
          daysOverdue: z.number().int().min(0).max(3650),
          alreadyCharged: z.bigint().min(0n).default(0n),
        })
        .refine((i) => (i.invoiceTypeId === undefined) !== (i.rule === undefined), { message: "Give an invoice type or a draft rule, not both and not neither" }),
    )
    .query(async ({ ctx, input }) => {
      let rule = input.rule;
      if (!rule) {
        const [saved] = await ctx.tx.select().from(lateFeeRule).where(and(eq(lateFeeRule.invoiceTypeId, input.invoiceTypeId!)));
        if (!saved) throw bad("That invoice type has no late-fee rule");
        rule = lateFeeRuleOf(saved);
      }
      const result = lateFee(rule, { overdueBalance: input.balance, invoiceTotal: input.invoiceTotal ?? input.balance }, input.daysOverdue, input.alreadyCharged);
      return { rule, ...result };
    });
}
