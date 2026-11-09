import { tariff, tariffVersion, tariffVersionLine } from "@flowless/db/schema/tariffs";
import { FLAT_BASES, TARIFF_TYPES } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { isUniqueViolation } from "../../kernel/pg-errors";
import { readSetting } from "../../kernel/config-store";
import { bandsFor, tariffContentSchema, toLineRows, validateTariffContent, type TariffContent } from "./content";
import { isoDateSchema, nextPeriodStartIso, versionInForce } from "./dating";
import { tariffVersionCreated } from "./events";
import type { TariffsProcedures } from "./procedures";
import {
  chooseEffectiveDate,
  findTariff,
  organizationToday,
  plain,
  tariffVersions,
  tidy,
  toTariffDto,
  type TariffRow,
  type WriteContext,
} from "./service";
import { closedThrough } from "./closed-period";
import { tariffPolicySetting } from "./settings";

const Name = z.string().trim().min(1).max(120);
const Note = z.string().trim().max(500).optional();

/**
 * Appends a version to a tariff (T-01, T-03): validates the content for the tariff's type,
 * picks the effective date (the next period start unless given; the first version starts
 * today), numbers the version and writes it and its lines, audited and published. The
 * tariff row is locked so two writers number versions in turn.
 */
export async function appendTariffVersion(ctx: WriteContext, t: TariffRow, input: { content: TariffContent; effectiveFrom?: string | undefined; note?: string | undefined }) {
  const checked = validateTariffContent(t, input.content);
  if (!checked.ok) throw new TRPCError({ code: "BAD_REQUEST", message: checked.problems.join("; ") });
  await findTariff(ctx.tx, t.id, true);
  const existing = await ctx.tx.select({ effectiveFrom: tariffVersion.effectiveFrom, versionNo: tariffVersion.versionNo }).from(tariffVersion).where(eq(tariffVersion.tariffId, t.id));
  const effectiveFrom = await chooseEffectiveDate(ctx.tx, ctx.organizationId, {
    requested: input.effectiveFrom,
    existing: existing.map((e) => e.effectiveFrom),
    first: existing.length === 0,
  });
  const versionNo = existing.reduce((max, e) => Math.max(max, e.versionNo), 0) + 1;
  const [version] = await ctx.tx
    .insert(tariffVersion)
    .values({ organizationId: ctx.organizationId, tariffId: t.id, versionNo, effectiveFrom, note: input.note || null, createdByUserId: ctx.session.user.id })
    .returning();
  await ctx.tx.insert(tariffVersionLine).values(toLineRows(checked.content).map((row) => ({ organizationId: ctx.organizationId, versionId: version!.id, ...row })));
  await ctx.audit({
    action: "tariffs.tariff_version_add",
    subjectType: "tariff",
    subjectId: t.id,
    after: plain({ versionId: version!.id, versionNo, effectiveFrom, content: checked.content }),
    reason: input.note || null,
  });
  await ctx.publish(tariffVersionCreated, { tariffId: t.id, versionId: version!.id, versionNo, type: t.type, effectiveFrom, createdByUserId: ctx.session.user.id });
  return { id: version!.id, versionNo, effectiveFrom };
}

/** Tariffs (T-01, T-03), mounted at the module's root: `tariffs.list`, `tariffs.create`, `tariffs.addVersion`, ... */
export function tariffProcedureSet(p: TariffsProcedures) {
  return {
    /** Tariffs with the version in force today and when the next one starts. */
    list: p.read.input(z.object({ active: z.boolean().optional(), type: z.enum(TARIFF_TYPES).optional() }).optional()).query(async ({ ctx, input }) => {
      const rows = await ctx.tx.select().from(tariff).orderBy(asc(tariff.name));
      const versions = await ctx.tx.select({ tariffId: tariffVersion.tariffId, versionNo: tariffVersion.versionNo, effectiveFrom: tariffVersion.effectiveFrom }).from(tariffVersion);
      const today = await organizationToday(ctx.tx);
      return rows
        .filter((t) => (input?.active === undefined || t.active === input.active) && (!input?.type || t.type === input.type))
        .map((t) => {
          const mine = versions.filter((v) => v.tariffId === t.id);
          const current = versionInForce(mine, today);
          const upcoming = mine.filter((v) => v.effectiveFrom > today).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
          return {
            ...toTariffDto(t),
            versionCount: mine.length,
            current: current ? { versionNo: current.versionNo, effectiveFrom: current.effectiveFrom } : null,
            nextChangeOn: upcoming?.effectiveFrom ?? null,
          };
        });
    }),

    /** One tariff with every version and its content, and the version in force today. */
    get: p.read.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
      const t = await findTariff(ctx.tx, input.id);
      const versions = await tariffVersions(ctx.tx, t);
      const today = await organizationToday(ctx.tx);
      return { ...toTariffDto(t), versions, inForce: versionInForce(versions, today) };
    }),

    /**
     * Creates a tariff and its first version (T-01). Block tariffs give ordered bands that
     * start at 0, meet exactly and end open, with rates that do not fall (increasing) or
     * rise (decreasing); uniform gives a rate; flat rate gives an amount per basis value.
     * Rates and amounts are minor units. The first version starts today unless dated.
     */
    create: p.manage
      .input(
        z.object({
          name: Name,
          type: z.enum(TARIFF_TYPES),
          flatBasis: z.enum(FLAT_BASES).optional(),
          content: tariffContentSchema,
          effectiveFrom: isoDateSchema.optional(),
          note: Note,
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const flatBasis = input.type === "flat_rate" ? (input.flatBasis ?? "none") : "none";
        if (input.type !== "flat_rate" && input.flatBasis && input.flatBasis !== "none") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Only a flat-rate tariff has a basis" });
        }
        const checked = validateTariffContent({ type: input.type, flatBasis }, input.content);
        if (!checked.ok) throw new TRPCError({ code: "BAD_REQUEST", message: checked.problems.join("; ") });
        const [row] = await ctx.tx
          .insert(tariff)
          .values({ organizationId: ctx.organizationId, name: tidy(input.name), type: input.type, flatBasis, createdByUserId: ctx.session.user.id })
          .returning()
          .catch((error: unknown) => {
            if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: "A tariff with that name already exists" });
            throw error;
          });
        await ctx.audit({ action: "tariffs.tariff_create", subjectType: "tariff", subjectId: row!.id, after: { name: row!.name, type: row!.type, flatBasis: row!.flatBasis } });
        const version = await appendTariffVersion(ctx, row!, { content: checked.content, effectiveFrom: input.effectiveFrom, note: input.note });
        return { ...toTariffDto(row!), firstVersion: version };
      }),

    /** Renames a tariff or switches it off (or on). Its type, basis and versions never change. */
    update: p.manage
      .input(z.object({ id: z.uuid(), name: Name.optional(), active: z.boolean().optional() }))
      .mutation(async ({ ctx, input }) => {
        const before = await findTariff(ctx.tx, input.id, true);
        const patch = { ...(input.name !== undefined ? { name: tidy(input.name) } : {}), ...(input.active !== undefined ? { active: input.active } : {}) };
        if ((patch.name === undefined || patch.name === before.name) && (patch.active === undefined || patch.active === before.active)) return toTariffDto(before);
        const [row] = await ctx.tx
          .update(tariff)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(tariff.id, before.id))
          .returning()
          .catch((error: unknown) => {
            if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: "A tariff with that name already exists" });
            throw error;
          });
        await ctx.audit({ action: "tariffs.tariff_update", subjectType: "tariff", subjectId: before.id, before: { name: before.name, active: before.active }, after: { name: row!.name, active: row!.active } });
        return toTariffDto(row!);
      }),

    /**
     * Adds a version (T-01, T-03): a change is a new version, never an edit. Without
     * `effectiveFrom` it takes effect at the next billing period start. A date inside a
     * closed period is refused; a date that already has a version and has arrived is
     * refused; one still ahead is replaced by this version.
     */
    addVersion: p.manage
      .input(z.object({ tariffId: z.uuid(), content: tariffContentSchema, effectiveFrom: isoDateSchema.optional(), note: Note }))
      .mutation(async ({ ctx, input }) => appendTariffVersion(ctx, await findTariff(ctx.tx, input.tariffId), input)),

    /** Every version of a tariff, oldest first, with its content and the days it covers. */
    versions: p.read.input(z.object({ tariffId: z.uuid() })).query(async ({ ctx, input }) => tariffVersions(ctx.tx, await findTariff(ctx.tx, input.tariffId))),

    /** The version in force on a date (default today) with its bands; null before the first version starts. */
    inForce: p.read.input(z.object({ tariffId: z.uuid(), date: isoDateSchema.optional() })).query(async ({ ctx, input }) => {
      const t = await findTariff(ctx.tx, input.tariffId);
      const on = input.date ?? (await organizationToday(ctx.tx));
      const version = versionInForce(await tariffVersions(ctx.tx, t), on);
      return { date: on, version, bands: version ? bandsFor(version.content) : [] };
    }),

    /**
     * The date a change made now would take effect (T-03): the next billing period start,
     * with the policy and the closed-period limit that decide it, for the form before it is saved.
     */
    nextEffectiveDate: p.read.query(async ({ ctx }) => {
      const policy = (await readSetting(ctx.tx, tariffPolicySetting)).value;
      const today = await organizationToday(ctx.tx);
      const closed = await closedThrough(ctx.tx, ctx.organizationId);
      return { today, effectiveFrom: nextPeriodStartIso(today, policy), periodStartDay: policy.periodStartDay, closedThrough: closed ? closed.toISOString().slice(0, 10) : null };
    }),
  };
}
