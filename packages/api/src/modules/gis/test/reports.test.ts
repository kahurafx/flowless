import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { withTenant } from "@flowless/db";
import { reportPublishProblems } from "../../../kernel/report-guard";
import { reports } from "../../../wiring";
import { expectCode, setupTestEnv, type TestEnv } from "./test-support";

describe("reports", () => {
  let env: TestEnv;
  const P = (lat: number, lng: number) => ({ lat, lng });
  beforeAll(async () => {
    env = await setupTestEnv();
    const org = () => env.gisOnly();
    const meter = await org().gis.nodes.create({ type: "meter", name: "Inlet", location: P(-1.3, 36.8), condition: "good" });
    const valve = await org().gis.nodes.create({ type: "valve", name: "Boundary", location: P(-1.301, 36.8), isOpen: true, condition: "good" });
    const shut = await org().gis.nodes.create({ type: "valve", name: "Shut", location: P(-1.302, 36.8), isOpen: false, condition: "good" });
    await org().gis.pipes.create({ fromNodeId: meter.id, toNodeId: valve.id, path: [meter.location, valve.location], diameterMm: 100 });
    await org().gis.logs.recordCondition({ assetId: shut.id, condition: "critical", note: "Spindle snapped" });
    const tier = await org().gis.tiers.create({ name: "DMA", order: 1 });
    await org().gis.dmas.create({
      areaId: (await env.dmaArea("Hill", env.members.gisOnly)).id,
      color: "#3B82F6",
      tierId: tier!.id,
      inletMeterId: meter.id,
      boundaryValveIds: [valve.id],
      ring: [P(-1.31, 36.79), P(-1.31, 36.81), P(-1.29, 36.81), P(-1.29, 36.79)],
    });
  });
  afterAll(async () => {
    await env.close();
  });

  it("sums up the live network", async () => {
    const s = await env.gisOnly().gis.reports.summary();
    assert.equal(s.assetsTracked, 4);
    assert.deepEqual(s.nodesByType, { meter: 1, valve: 2 });
    assert.equal(s.closedValves, 1);
    assert.equal(s.needingAttention, 1);
    assert.ok(s.networkLengthM > 100 && s.networkLengthM < 120, String(s.networkLengthM));
  });

  it("raises the critical valve and the DMA whose boundary valve is open", async () => {
    const alerts = await env.gisOnly().gis.reports.alerts();
    assert.deepEqual(alerts.map((a) => a.kind).sort(), ["condition", "dma_boundary"]);
    const condition = alerts.find((a) => a.kind === "condition");
    assert.equal(condition?.description, "Spindle snapped");
    assert.ok(alerts.every((a) => a.severity === "critical"));
  });

  it("counts each inspected asset at its latest condition, month by month", async () => {
    const trend = await env.gisOnly().gis.reports.conditionTrend({ months: 3 });
    assert.equal(trend.length, 3);
    const thisMonth = trend.at(-1)!;
    assert.deepEqual([thisMonth.critical, thisMonth.poorOrCriticalLogs], [1, 1]);
  });

  it("is not found for organizations without GIS (K-04)", async () => {
    await expectCode(env.bare().gis.reports.summary(), "NOT_FOUND");
  });

  it("registers its tabular reports, and they pass the publish guard (X-04)", async () => {
    assert.deepEqual(
      reports.filter((r) => r.module === "gis").map((r) => r.key).sort(),
      ["gis.condition_trend", "gis.recent_findings"],
    );
    for (const report of reports.filter((r) => r.module === "gis")) {
      const problems = await withTenant(env.t.app, env.orgC, (tx) => reportPublishProblems(tx, report.query(report.params.parse({}))));
      assert.deepEqual(problems, [], report.key);
    }
  });

  it("lists recent findings on live assets", async () => {
    const findings = await env.gisOnly().gis.reports.recentFindings();
    assert.deepEqual(findings.map((f) => f.condition), ["critical"]);
  });
});
