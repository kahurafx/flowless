import { conditionLog, dma, node, pipe, structure } from "@flowless/db/schema/gis";
import type { AssetCondition } from "@flowless/shared-types";
import { desc, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { defineReport } from "../../kernel/report-guard";
import { router } from "../../trpc";
import { MAIN } from "./common";
import { areaNames, loadBoundaryValves } from "./dma-store";
import { notDeletedAsset } from "./deleted";
import type { GisProcedures } from "./procedures";
import { listEffective } from "./versioning/engine";

/*
 * Read-only numbers for the office dashboard and reports, ported from Majimap's
 * reports.ts. Everything is about the live network (main): a branch isn't the network yet.
 *
 * The two tabular queries are reports (X-01): `defineReport`, registered in
 * the module's `registerKernel` (see `src/wiring.ts`), so the X-04 guard plans them and the isolation canary runs
 * them; they rely on RLS, never on an organization filter. `summary` and `alerts` stay
 * procedures: they combine several versioned tables through the branch overlay and the
 * DMA valve sets in code, which no single query expresses. Majimap's `technicianActivity`
 * (members' last sync) is not ported: GIS does not read identities, and Flowless records
 * device sync in the mobile step (W5).
 */

const NEEDS_ATTENTION: readonly AssetCondition[] = ["poor", "critical"];

/** Recent poor and critical inspections on assets still live, newest first. */
export const recentFindingsReport = defineReport({
  key: "gis.recent_findings",
  module: "gis",
  label: "Recent poor and critical inspections",
  params: z.object({ days: z.number().int().min(1).max(365).default(90) }),
  query: ({ days }) => sql`
    select l.id, l.asset_id as "assetId", l.condition::text as condition, l.note, l.recorded_at as "recordedAt"
      from ${conditionLog} l
     where l.condition in ('poor', 'critical')
       and l.recorded_at >= now() - make_interval(days => ${days})
       and ${notDeletedAsset(sql`l.asset_id`)}
     order by l.recorded_at desc
     limit 200`,
});

/**
 * Network condition month by month: each inspected asset counted at the condition of its
 * latest main-branch inspection by the end of that month, plus how many inspections that
 * month found something poor or critical. One row per (month, condition) with `n`, and a
 * `flagged` count per month.
 */
export const conditionTrendReport = defineReport({
  key: "gis.condition_trend",
  module: "gis",
  label: "Network condition by month",
  params: z.object({ months: z.number().int().min(1).max(36).default(6) }),
  query: ({ months }) => sql`
    with months as (
      select generate_series(date_trunc('month', now()) - make_interval(months => ${months - 1}), date_trunc('month', now()), interval '1 month') as m
    )
    select to_char(m, 'YYYY-MM') as month, latest.condition::text as condition, count(*)::int as n,
           (select count(*)::int from ${conditionLog} f
             where f.condition in ('poor', 'critical') and date_trunc('month', f.recorded_at) = m) as flagged
      from months
      left join lateral (
        select distinct on (l.asset_id) l.asset_id, l.condition
          from ${conditionLog} l
         where l.branch = ${MAIN} and l.recorded_at < m + interval '1 month' and ${notDeletedAsset(sql`l.asset_id`)}
         order by l.asset_id, l.recorded_at desc
      ) latest on true
     group by m, latest.condition
     order by m`,
});

export function reportsRouter(p: GisProcedures) {
  return router({
    /** The dashboard's headline numbers. */
    summary: p.read.query(async ({ ctx }) => {
      const scope = { orgId: ctx.organizationId, branch: MAIN };
      const nodeRows = await listEffective(ctx.tx, node, scope);
      const pipeRows = await listEffective(ctx.tx, pipe, scope);
      const structureRows = await listEffective(ctx.tx, structure, scope);
      const attention = (c: AssetCondition) => NEEDS_ATTENTION.includes(c);
      const byType: Record<string, number> = {};
      for (const n of nodeRows) byType[n.type] = (byType[n.type] ?? 0) + 1;
      return {
        assetsTracked: nodeRows.length + pipeRows.length + structureRows.length,
        nodesByType: byType,
        pipeCount: pipeRows.length,
        networkLengthM: Math.round(pipeRows.reduce((sum, x) => sum + x.lengthM, 0)),
        closedValves: nodeRows.filter((n) => n.type === "valve" && n.isOpen === false).length,
        needingAttention:
          nodeRows.filter((n) => attention(n.condition)).length +
          pipeRows.filter((x) => attention(x.condition)).length +
          structureRows.filter((s) => attention(s.condition)).length,
      };
    }),

    /** Network condition month by month (the `gis.condition_trend` report, shaped for a chart). */
    conditionTrend: p.read.input(z.object({ months: z.number().int().min(1).max(36).default(6) }).optional()).query(async ({ ctx, input }) => {
      const params = conditionTrendReport.params.parse(input ?? {});
      const result = await ctx.tx.execute<{ month: string; condition: AssetCondition | null; n: number; flagged: number }>(conditionTrendReport.query(params));
      const rows = new Map<string, { month: string; good: number; fair: number; poor: number; critical: number; poorOrCriticalLogs: number }>();
      const now = new Date();
      for (let i = params.months - 1; i >= 0; i--) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        rows.set(key, { month: key, good: 0, fair: 0, poor: 0, critical: 0, poorOrCriticalLogs: 0 });
      }
      for (const r of result) {
        const row = rows.get(r.month);
        if (!row) continue;
        row.poorOrCriticalLogs = r.flagged;
        if (r.condition && r.condition in row) row[r.condition as "good" | "fair" | "poor" | "critical"] = r.n;
      }
      return [...rows.values()];
    }),

    /** Recent poor and critical inspections (the `gis.recent_findings` report). */
    recentFindings: p.read.input(z.object({ days: z.number().int().min(1).max(365).default(90) }).optional()).query(async ({ ctx, input }) => {
      return ctx.tx.execute<{ id: string; assetId: string; condition: AssetCondition; note: string | null; recordedAt: Date }>(
        recentFindingsReport.query(recentFindingsReport.params.parse(input ?? {})),
      );
    }),

    /**
     * What needs someone's attention now: assets in poor or critical condition (with the
     * inspection that said so), and DMAs whose boundary valves aren't all confirmed closed.
     * Critical first, then newest.
     */
    alerts: p.read.query(async ({ ctx }) => {
      const scope = { orgId: ctx.organizationId, branch: MAIN };
      const nodeRows = await listEffective(ctx.tx, node, scope);
      const pipeRows = await listEffective(ctx.tx, pipe, scope);
      const structureRows = await listEffective(ctx.tx, structure, scope);
      const dmaRows = await listEffective(ctx.tx, dma, scope);

      const flagged = [
        ...nodeRows.map((n) => ({ id: n.id, name: n.name, condition: n.condition, type: "node" as const })),
        ...pipeRows.map((x) => ({ id: x.id, name: `Pipe ${x.id.slice(0, 8)}`, condition: x.condition, type: "pipe" as const })),
        ...structureRows.map((s) => ({ id: s.id, name: s.name, condition: s.condition, type: "structure" as const })),
      ].filter((a) => NEEDS_ATTENTION.includes(a.condition));

      const latestLog = new Map<string, { note: string | null; recordedAt: Date }>();
      if (flagged.length > 0) {
        const logs = await ctx.tx
          .selectDistinctOn([conditionLog.assetId], { assetId: conditionLog.assetId, note: conditionLog.note, recordedAt: conditionLog.recordedAt })
          .from(conditionLog)
          .where(
            inArray(
              conditionLog.assetId,
              flagged.map((a) => a.id),
            ),
          )
          .orderBy(conditionLog.assetId, desc(conditionLog.recordedAt));
        for (const l of logs) latestLog.set(l.assetId, { note: l.note, recordedAt: l.recordedAt });
      }

      type Alert = {
        id: string;
        severity: "critical" | "warning";
        kind: "condition" | "dma_boundary";
        title: string;
        description: string;
        subjectId: string;
        subjectType: "node" | "pipe" | "structure" | "dma";
        occurredAt: Date;
      };
      const alerts: Alert[] = flagged.map((a) => {
        const log = latestLog.get(a.id);
        return {
          id: `condition:${a.id}`,
          severity: a.condition === "critical" ? "critical" : "warning",
          kind: "condition",
          title: `${a.name} is in ${a.condition} condition`,
          description: log?.note ?? "No note recorded.",
          subjectId: a.id,
          subjectType: a.type,
          occurredAt: log?.recordedAt ?? new Date(),
        };
      });

      const valves = await loadBoundaryValves(
        ctx.tx,
        dmaRows.map((d) => d.versionId),
      );
      const names = await areaNames(
        ctx.tx,
        dmaRows.map((d) => d.areaId),
      );
      const nodeById = new Map(nodeRows.map((n) => [n.id, n]));
      for (const d of dmaRows) {
        // Same rule as dmas.analysis: a valve nobody has confirmed closed isn't sealing anything.
        const open = (valves.get(d.versionId) ?? []).map((id) => nodeById.get(id)).filter((n) => n && n.isOpen !== false);
        if (open.length === 0) continue;
        alerts.push({
          id: `dma:${d.areaId}`,
          severity: "critical",
          kind: "dma_boundary",
          title: `${names.get(d.areaId) ?? "DMA"}: ${open.length} boundary valve${open.length === 1 ? "" : "s"} not closed`,
          description: `${open.map((v) => v!.name).join(", ")} should be closed to keep this DMA isolated.`,
          subjectId: d.areaId,
          subjectType: "dma",
          occurredAt: d.createdAt,
        });
      }
      return alerts.sort((a, b) => (a.severity !== b.severity ? (a.severity === "critical" ? -1 : 1) : b.occurredAt.getTime() - a.occurredAt.getTime()));
    }),
  });
}
