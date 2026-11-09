import { relocationEvent } from "@flowless/db/schema/accounts";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activationConfigSchema } from "../gates";
import { activationSetting } from "../settings";
import { expectCode, setupAccountsEnv, type AccountsEnv } from "./test-support";

/*
 * The shared step-log rule (`defineStepLog` in `idempotent.ts`), pinned on the relocation log,
 * the one the other suites do not cover step by step: the same id replays only for the same
 * relocation, kind, actor and request; anything else is CONFLICT. Lifecycle and application
 * tests pin the same rule for `account_command` and `application_event`.
 */

let env: AccountsEnv;
beforeAll(async () => {
  env = await setupAccountsEnv();
  const current = (await env.admin.config.list()).find((c) => c.key === activationSetting.key)!;
  const value = activationConfigSchema.parse({ gates: { payment_threshold: { enabled: false }, meter_installed: { enabled: false }, initial_reading: { enabled: false } } });
  await env.admin.config.set({ key: activationSetting.key, value, expectedVersion: current.version });
});
afterAll(() => env?.t.stop());

/** An ACTIVE account with two connected service points, and a relocation requested on each. */
async function twoRelocations() {
  const customer = await env.person(env.clerk(), `Holder ${randomUUID().slice(0, 6)}`);
  const a = await env.clerk().accounts.create({ customerId: customer.id });
  await env.manager().accounts.activate({ accountId: a.id, reason: "Test" });
  const requests = [];
  for (const n of [1, 2]) {
    const point = await env.clerk().accounts.servicePoints.create({
      accountId: a.id,
      address: `Plot ${n}`,
      location: { lat: -1.2, lng: 36.9 },
      schemeId: env.areas.scheme,
      zoneId: env.areas.zone,
      routeId: env.routes.route,
      connectionStatus: "CONNECTED",
    });
    requests.push(
      (
        await env.manager().accounts.relocations.request({
          accountId: a.id,
          fromServicePointId: point.id,
          to: { address: `New plot ${n}`, schemeId: env.areas.scheme, zoneId: env.areas.otherZone, routeId: env.routes.otherRoute },
          reason: "Moves",
        })
      ).relocation.id,
    );
  }
  return requests as [string, string];
}

describe("the step log's replay rule (relocation_event)", () => {
  it("replays the same request and writes one row", async () => {
    const [relocationId] = await twoRelocations();
    const id = randomUUID();
    const req = { id, relocationId, feasibility: "feasible" as const, findings: "Main 5 m away" };
    const first = await env.manager().accounts.relocations.recordSurvey(req);
    const again = await env.manager().accounts.relocations.recordSurvey(req);
    expect([first.replayed, again.replayed, again.relocation.status]).toEqual([false, true, "surveyed"]);
    expect(await env.db.select().from(relocationEvent).where(eq(relocationEvent.id, id))).toHaveLength(1);
  });

  it("is CONFLICT under another request, relocation, kind or person", async () => {
    const [first, second] = await twoRelocations();
    const id = randomUUID();
    const survey = { id, relocationId: first, feasibility: "feasible" as const, findings: "Main 5 m away" };
    await env.manager().accounts.relocations.recordSurvey(survey);
    const r = env.manager().accounts.relocations;
    await expectCode(r.recordSurvey({ ...survey, findings: "Different" }), "CONFLICT");
    await expectCode(r.recordSurvey({ ...survey, relocationId: second }), "CONFLICT");
    await expectCode(r.cancel({ id, relocationId: first, reason: "Changed their mind" }), "CONFLICT");
    await expectCode(env.admin.accounts.relocations.recordSurvey(survey), "CONFLICT");
    // None of the refusals wrote anything.
    expect(await env.db.select().from(relocationEvent).where(eq(relocationEvent.id, id))).toHaveLength(1);
  });

  it("writes the log row before the change, whatever the step: statuses follow the log", async () => {
    const [relocationId] = await twoRelocations();
    const r = env.manager().accounts.relocations;
    await r.recordWork({ relocationId, finalReading: "10" });
    await r.recordSurvey({ relocationId, feasibility: "feasible", findings: "OK" });
    await r.cancel({ relocationId, reason: "Stop" });
    const rows = (await env.db.select().from(relocationEvent).where(eq(relocationEvent.relocationId, relocationId))).sort((x, y) => Number(x.occurredAt) - Number(y.occurredAt));
    expect(rows.map((e) => [e.kind, e.fromStatus, e.toStatus])).toEqual([
      ["requested", null, "requested"],
      ["work_recorded", "requested", "requested"],
      ["survey_recorded", "requested", "surveyed"],
      ["cancelled", "surveyed", "cancelled"],
    ]);
  });
});
