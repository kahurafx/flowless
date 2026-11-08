import { configVersion, type Transaction } from "@flowless/db";
import { TRPCError } from "@trpc/server";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { permittedProcedure, router } from "../trpc";
import { latestVersion, readSetting, writeSetting, type SettingDef } from "./config-store";
import { settings as registered } from "./config-registry";
import { isUniqueViolation } from "./pg-errors";

/** A minute of clock skew between browser and server is not "the past". */
const PAST_TOLERANCE_MS = 60_000;

/** Key-order independent comparison (jsonb reorders keys). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const scheduledOf = (tx: Transaction, key: string, now: Date) =>
  tx
    .select({ version: configVersion.version, value: configVersion.value, effectiveFrom: configVersion.effectiveFrom })
    .from(configVersion)
    .where(eq(configVersion.key, key))
    .orderBy(asc(configVersion.effectiveFrom), asc(configVersion.version))
    .then((rows) => rows.filter((r) => r.effectiveFrom > now));

/**
 * The configuration store (K-10, NF-32) for administrators: `settings:manage` to read and
 * change. Settings of unlicensed modules are hidden (K-04). Every change is a new version
 * and audited (K-06). Procedures read values with `ctx.config(def)` instead.
 */
export function createConfigRouter(defs: readonly SettingDef[]) {
  const visible = async (ctx: { entitlements: () => Promise<readonly string[]> }) => {
    const licensed = await ctx.entitlements();
    return defs.filter((d) => d.module === "kernel" || licensed.includes(d.module));
  };
  const find = async (ctx: { entitlements: () => Promise<readonly string[]> }, key: string) => {
    const def = (await visible(ctx)).find((d) => d.key === key);
    if (!def) throw new TRPCError({ code: "NOT_FOUND", message: "Setting not found" });
    return def;
  };

  return router({
    list: permittedProcedure("settings:manage").query(async ({ ctx }) => {
      const now = new Date();
      return Promise.all(
        (await visible(ctx)).map(async (def) => {
          const current = await readSetting(ctx.tx, def, now);
          return {
            key: def.key,
            module: def.module,
            label: def.label,
            description: def.description,
            ...current,
            isDefault: current.version === 0,
            latestVersion: await latestVersion(ctx.tx, def.key),
            scheduled: await scheduledOf(ctx.tx, def.key, now),
          };
        }),
      );
    }),

    /** Every version of a setting, newest first. */
    history: permittedProcedure("settings:manage")
      .input(z.object({ key: z.string() }))
      .query(async ({ ctx, input }) => {
        const def = await find(ctx, input.key);
        return ctx.tx
          .select({
            version: configVersion.version,
            value: configVersion.value,
            effectiveFrom: configVersion.effectiveFrom,
            reason: configVersion.reason,
            createdByUserId: configVersion.createdByUserId,
            createdAt: configVersion.createdAt,
          })
          .from(configVersion)
          .where(eq(configVersion.key, def.key))
          .orderBy(desc(configVersion.version));
      }),

    /**
     * Sets a value from now, or from a future date (a scheduled change). `expectedVersion`
     * is the newest version the editor saw; if someone changed it since, CONFLICT.
     */
    set: permittedProcedure("settings:manage")
      .input(
        z.object({
          key: z.string(),
          value: z.unknown(),
          expectedVersion: z.number().int().min(0),
          effectiveFrom: z.date().optional(),
          reason: z.string().trim().max(500).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const def = await find(ctx, input.key);
        const now = new Date();
        if (input.effectiveFrom && input.effectiveFrom.getTime() < now.getTime() - PAST_TOLERANCE_MS) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "A change cannot take effect in the past" });
        }
        const parsed = def.schema.safeParse(input.value);
        if (!parsed.success) throw new TRPCError({ code: "BAD_REQUEST", message: parsed.error.issues[0]?.message ?? "Invalid value" });

        const latest = await latestVersion(ctx.tx, def.key);
        const conflict = () =>
          new TRPCError({ code: "CONFLICT", message: "Someone changed this setting since you opened it. Reload and try again." });
        if (latest !== input.expectedVersion) throw conflict();

        const current = await readSetting(ctx.tx, def, now);
        const scheduled = latest !== current.version;
        if (!input.effectiveFrom && !scheduled && canonical(current.value) === canonical(parsed.data)) {
          return { version: current.version, changed: false };
        }

        let written: { version: number } | null;
        try {
          written = await writeSetting(ctx.tx, ctx.organizationId, def, {
            value: parsed.data,
            version: latest + 1,
            effectiveFrom: input.effectiveFrom ?? now,
            reason: input.reason || null,
            createdByUserId: ctx.session.user.id,
          });
        } catch (error) {
          if (isUniqueViolation(error)) throw conflict();
          throw error;
        }
        if (!written) throw conflict();

        await ctx.audit({
          action: "config.set",
          subjectType: "setting",
          subjectId: def.key,
          before: { version: current.version, value: current.value },
          after: { version: written.version, value: parsed.data, effectiveFrom: (input.effectiveFrom ?? now).toISOString() },
          reason: input.reason || null,
        });
        return { version: written.version, changed: true };
      }),
  });
}

export const configRouter = createConfigRouter(registered);
