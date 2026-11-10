import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { permittedProcedure, router } from "../trpc";
import { EXPORT_TYPES, toCsv, toXlsx } from "./report-export";
import { describeReport, missingPermissions, organizationCurrencyOf, published, reportFor, runReport, type Caller } from "./report-run";

const runInput = z.object({ key: z.string().min(1).max(100), params: z.record(z.string(), z.unknown()).default({}) });

/**
 * The reporting engine (X-01, X-03). `list` shows the reports the caller may run: their module
 * is licensed (NF-03) and they hold the report's permissions. `run` needs `reports:read`,
 * `export` needs `reports:export`, both on top of the report's own permissions. Scope (K-03)
 * is applied by the report from the session, never from what the caller sends. Exports are
 * audited with the parameters and row count (K-06) and are mutations, so support access (read
 * only) cannot produce files.
 */
export const reportsRouter = router({
  list: permittedProcedure("reports:read").query(async ({ ctx }) => {
    const licensed = await ctx.entitlements();
    return published()
      .filter((r) => (r.module === "kernel" || licensed.includes(r.module)) && missingPermissions(r.meta!, ctx.permissions, "reports:read").length === 0)
      .map((r) => describeReport(r as Parameters<typeof describeReport>[0]))
      .sort((a, b) => a.label.localeCompare(b.label));
  }),

  run: permittedProcedure("reports:read")
    .input(runInput)
    .query(async ({ ctx, input }) => {
      const caller = await callerOf(ctx);
      const def = reportFor(input.key, caller);
      assertAllowed(def.meta, ctx.permissions, "reports:read");
      return runReport(caller, def, input.params, def.meta.rowCap);
    }),

  export: permittedProcedure("reports:export")
    .input(runInput.extend({ format: z.enum(["csv", "xlsx"]) }))
    .mutation(async ({ ctx, input }) => {
      const caller = await callerOf(ctx);
      const def = reportFor(input.key, caller);
      assertAllowed(def.meta, ctx.permissions, "reports:export");
      const result = await runReport(caller, def, input.params, def.meta.exportRowCap);
      const currency = await organizationCurrencyOf(ctx.tx);
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `${def.key.replace(/[^a-z0-9_.-]/gi, "_")}-${stamp}.${input.format}`;
      await ctx.audit({
        action: "reports.export",
        subjectType: "report",
        subjectId: def.key,
        before: null,
        after: { format: input.format, rows: result.rows.length, truncated: result.truncated, params: JSON.parse(JSON.stringify(result.params, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) },
      });
      const base = { key: def.key, filename, contentType: EXPORT_TYPES[input.format], rows: result.rows.length, truncated: result.truncated };
      if (input.format === "csv") return { ...base, encoding: "utf8" as const, content: toCsv(result.columns, result.rows, currency) };
      return { ...base, encoding: "base64" as const, content: (await toXlsx(def.label, result.columns, result.rows, currency)).toString("base64") };
    }),
});

function assertAllowed(meta: { permissions: readonly string[] }, permissions: ReadonlySet<string>, base: "reports:read" | "reports:export") {
  const missing = [base, ...meta.permissions].filter((p) => !permissions.has(p));
  if (missing.length) throw new TRPCError({ code: "FORBIDDEN", message: `This report needs ${missing.join(", ")}` });
}

async function callerOf(ctx: {
  tx: Caller["tx"];
  session: { user: { id: string } };
  permissions: ReadonlySet<string>;
  scope(): Promise<Caller["scope"]>;
  entitlements(): Promise<Caller["licensed"]>;
}): Promise<Caller> {
  return { tx: ctx.tx, userId: ctx.session.user.id, scope: await ctx.scope(), permissions: ctx.permissions, licensed: await ctx.entitlements() };
}
