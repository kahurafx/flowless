import { exception, withTenant } from "@flowless/db";
import { servicePoint } from "@flowless/db/schema/accounts";
import { DATA_QUALITY_RULE_KEYS, type DataQualityRuleKey } from "@flowless/shared-types";
import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setEntitlements } from "../../../kernel/entitlement-store";
import { reportPublishProblems } from "../../../kernel/report-guard";
import { reports } from "../../../wiring";
import { addMember } from "../../../test-support";
import { dataQualityFindingsReport, dataQualitySummaryReport, registerDataQualitySource, sweepDataQuality } from "..";
import { dataQualitySetting } from "../settings";
import { expectCode, setupAccountsEnv, type AccountsEnv } from "./test-support";

let env: AccountsEnv;
beforeAll(async () => {
  env = await setupAccountsEnv();
  // Activation without gates, so a test can make an ACTIVE account in one call.
  const current = (await env.admin.config.list()).find((s) => s.key === "accounts.activation")!;
  await env.admin.config.set({
    key: "accounts.activation",
    value: { mode: "checklist", staleAfterDays: 14, gates: { payment_threshold: { enabled: false }, meter_installed: { enabled: false }, initial_reading: { enabled: false } }, officeChecklist: [] },
    expectedVersion: current.version,
  });
});
afterAll(() => env?.t.stop());
afterEach(async () => {
  registerDataQualitySource("active_metered_no_meter", null);
  await setEntitlements(env.t.app, env.orgA, ["accounts"]);
  await configure({});
});

const GPS = { lat: -1.2, lng: 36.8 };
let seq = 0;
const unique = (prefix: string) => `${prefix} ${++seq} ${randomUUID().slice(0, 6)}`;

/** Writes tenant A's data-quality setting. */
async function configure(rules: Record<string, { enabled?: boolean; severity?: string; raiseExceptions?: boolean }>) {
  const current = (await env.admin.config.list()).find((s) => s.key === dataQualitySetting.key)!;
  await env.admin.config.set({ key: dataQualitySetting.key, value: { rules }, expectedVersion: current.version });
}

/** An account for a new customer: with a real phone unless `contacts` says otherwise; ACTIVE unless `status` says otherwise. */
async function open(
  opts: { contacts?: { channel: "phone" | "email"; value: string }[]; status?: "NEW" | "ACTIVE"; place?: Record<string, unknown> | null; categoryId?: string; customer?: Record<string, unknown> } = {},
) {
  const clerk = env.clerk();
  const customer = await env.person(clerk, unique("Customer"), { contacts: opts.contacts ?? [{ channel: "phone", value: `07${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}` }], ...opts.customer });
  const a = await clerk.accounts.create({ customerId: customer.id, ...(opts.categoryId ? { categoryId: opts.categoryId } : {}) });
  if (opts.place !== null) await clerk.accounts.servicePoints.create({ accountId: a.id, address: "Plot 1", location: GPS, zoneId: env.areas.zone, routeId: env.routes.route, ...opts.place });
  if ((opts.status ?? "ACTIVE") === "ACTIVE") await env.manager().accounts.activate({ accountId: a.id, reason: "Test" });
  return { ...a, customerId: customer.id };
}

const flagged = async (rule: DataQualityRuleKey, caller = env.admin) => {
  const numbers: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await caller.accounts.dataQuality.findings({ rule, limit: 5, ...(after ? { after } : {}) });
    numbers.push(...page.items.map((i) => i.number));
    if (!page.nextCursor) return numbers;
    after = page.nextCursor;
  }
};
const exceptionsOf = (rule: string) => env.db.select().from(exception).where(and(eq(exception.source, "accounts"), eq(exception.type, "DATA_QUALITY"), like(exception.dedupeKey, `dq:${rule}:%`)));

// C-12: the rules, one by one.
describe("data-quality rules", () => {
  it("lists the catalogue with the effective configuration, and the meter rule waiting on Metering", async () => {
    const rules = await env.cashier().accounts.dataQuality.rules();
    expect(rules.map((r) => r.key)).toEqual([...DATA_QUALITY_RULE_KEYS]);
    expect(rules.find((r) => r.key === "account_no_phone")).toMatchObject({ enabled: true, state: "enabled", severity: "warning", raiseExceptions: false, hasSource: true });
    expect(rules.find((r) => r.key === "active_metered_no_meter")).toMatchObject({ enabled: true, state: "no_source", hasSource: false });
    await configure({ account_no_phone: { enabled: false, severity: "critical" }, zone_equals_route: { raiseExceptions: true } });
    const changed = await env.cashier().accounts.dataQuality.rules();
    expect(changed.find((r) => r.key === "account_no_phone")).toMatchObject({ enabled: false, state: "disabled", severity: "critical" });
    expect(changed.find((r) => r.key === "zone_equals_route")).toMatchObject({ enabled: true, raiseExceptions: true });
    await expectCode(env.cashier().accounts.dataQuality.findings({ rule: "account_no_phone" }), "PRECONDITION_FAILED");
    const summary = await env.cashier().accounts.dataQuality.summary();
    expect(summary.rules.find((r) => r.key === "account_no_phone")).toMatchObject({ state: "disabled", count: null, severity: "critical" });
  });

  it("is read-only for accounts:read and closed to a member without it, and only Accounts' licence opens it", async () => {
    await expect(env.cashier().accounts.dataQuality.summary()).resolves.toBeTruthy();
    const nobody = await addMember(env.t, env.orgA, "nobody");
    await expectCode(env.as(nobody).accounts.dataQuality.summary(), "FORBIDDEN");
    await expectCode(env.bare().accounts.dataQuality.summary(), "NOT_FOUND");
  });

  it("account_no_phone: no contact or only placeholders; a real phone anywhere is enough; terminated accounts are skipped", async () => {
    const none = await open({ contacts: [], place: null, status: "NEW" });
    const email = await open({ contacts: [{ channel: "email", value: "x@example.test" }], place: null, status: "NEW" });
    const placeholder = await open({ contacts: [{ channel: "phone", value: "25400000000" }], place: null, status: "NEW" });
    const real = await open({ contacts: [{ channel: "phone", value: "0733 111 222" }], place: null, status: "NEW" });
    const both = await open({ contacts: [{ channel: "phone", value: "0000000000" }, { channel: "phone", value: "0733 222 333" }], place: null, status: "NEW" });
    const ended = await open({ contacts: [], place: null, status: "NEW" });
    await env.manager().accounts.terminate({ accountId: ended.id, reason: "Not going ahead", acknowledgeNoLedger: true });

    const numbers = await flagged("account_no_phone");
    expect(numbers).toEqual(expect.arrayContaining([none.number, email.number, placeholder.number]));
    for (const ok of [real, both, ended]) expect(numbers).not.toContain(ok.number);
    expect(numbers).toEqual([...numbers].sort());
  });

  it("account_no_service_point and account_no_coordinates: several points, decommissioned points, NEW accounts", async () => {
    const bare = await open({ place: null });
    const noGps = await open({ place: { location: undefined } });
    const withGps = await open();
    const two = await open({ place: { location: undefined } });
    await env.clerk().accounts.servicePoints.create({ accountId: two.id, address: "Plot 2", location: GPS, zoneId: env.areas.zone });
    const gone = await open();
    const [point] = await env.db.select().from(servicePoint).where(eq(servicePoint.accountId, gone.id));
    await env.clerk().accounts.servicePoints.update({ id: point!.id, patch: { connectionStatus: "DECOMMISSIONED" } });
    const enquiry = await open({ place: null, status: "NEW" });

    const noPoint = await flagged("account_no_service_point");
    expect(noPoint).toEqual(expect.arrayContaining([bare.number, gone.number]));
    for (const ok of [noGps, withGps, two, enquiry]) expect(noPoint).not.toContain(ok.number);

    const noGpsFound = await flagged("account_no_coordinates");
    expect(noGpsFound).toEqual(expect.arrayContaining([bare.number, noGps.number, gone.number]));
    for (const ok of [withGps, two, enquiry]) expect(noGpsFound).not.toContain(ok.number);
  });

  it("account_category_missing: only a null category without Tariffs; unknown and deactivated ones too with it", async () => {
    const none = await open();
    const unknown = await open({ categoryId: randomUUID() });
    await expect(env.admin.accounts.dataQuality.summary()).resolves.toMatchObject({ categoriesChecked: false });
    let numbers = await flagged("account_category_missing");
    expect(numbers).toContain(none.number);
    expect(numbers).not.toContain(unknown.number);

    await setEntitlements(env.t.app, env.orgA, ["accounts", "tariffs"]);
    const good = await env.admin.tariffs.categories.create({ code: unique("dq_good").replace(/\s/g, "_"), name: "Good" });
    const retired = await env.admin.tariffs.categories.create({ code: unique("dq_old").replace(/\s/g, "_"), name: "Retired" });
    const withGood = await open({ categoryId: good.id });
    const withRetired = await open({ categoryId: retired.id });
    await env.admin.tariffs.categories.deactivate({ id: retired.id });

    await expect(env.admin.accounts.dataQuality.summary()).resolves.toMatchObject({ categoriesChecked: true });
    numbers = await flagged("account_category_missing");
    expect(numbers).toEqual(expect.arrayContaining([none.number, unknown.number, withRetired.number]));
    expect(numbers).not.toContain(withGood.number);
  });

  it("zone_equals_route: same name, an unrelated route area, several points, an archived area; says which", async () => {
    const same = await env.admin.hierarchy.createRoute({ code: unique("SAME"), name: "Kahawa West zone 1" });
    const fine = await open();
    const sameName = await open({ place: { routeId: same.id } });
    const unrelated = await open({ place: { routeId: env.routes.otherRoute } });
    const noRouteArea = await open({ place: { routeId: (await env.admin.hierarchy.createRoute({ code: unique("FREE"), name: "Free route" })).id } });
    const mixed = await open();
    await env.clerk().accounts.servicePoints.create({ accountId: mixed.id, address: "Plot 5", location: GPS, zoneId: env.areas.zone, routeId: env.routes.otherRoute });
    const oldZone = await env.admin.hierarchy.createArea({ level: "zone", code: unique("OLD"), name: "Old Zone", parentId: env.areas.scheme });
    const oldRoute = await env.admin.hierarchy.createRoute({ code: unique("OLDR"), name: "old zone" });
    const archived = await open({ place: { zoneId: oldZone.id, routeId: oldRoute.id } });
    await env.admin.hierarchy.archiveArea({ id: oldZone.id });

    const page = await env.admin.accounts.dataQuality.findings({ rule: "zone_equals_route", limit: 200 });
    const by = new Map(page.items.map((i) => [i.number, i]));
    expect([...by.keys()]).toEqual(expect.arrayContaining([sameName.number, unrelated.number, mixed.number, archived.number]));
    for (const ok of [fine, noRouteArea]) expect(by.has(ok.number)).toBe(false);
    expect(by.get(sameName.number)!.why).toMatch(/same name as the area "Kahawa West zone 1"/);
    expect(by.get(unrelated.number)!.why).toMatch(/Route 2.*Ruiru/);
    // The account with two points is shown with the offending one.
    expect(by.get(mixed.number)).toMatchObject({ routeId: env.routes.otherRoute, routeLabel: "Route 2" });
    expect(by.get(archived.number)).toMatchObject({ areaLabel: "Old Zone", routeLabel: "old zone" });
    expect(page.items.filter((i) => i.number === mixed.number)).toHaveLength(1);
  });

  it("duplicate_customers: same phone in another spelling, national id, registration number; placeholders and singles are not duplicates", async () => {
    const p1 = await open({ place: null, status: "NEW", contacts: [{ channel: "phone", value: "0711 000 111" }] });
    const p2 = await open({ place: null, status: "NEW", contacts: [{ channel: "phone", value: "+254 711 000 111" }] });
    const nid = `ID${randomUUID().slice(0, 8).toUpperCase()}`;
    const n1 = await open({ place: null, status: "NEW", customer: { nationalId: nid } });
    const n2 = await open({ place: null, status: "NEW", customer: { nationalId: ` ${nid.toLowerCase()} ` } });
    const reg = `REG${randomUUID().slice(0, 8).toUpperCase()}`;
    const o1 = await open({ place: null, status: "NEW", customer: { type: "organization", registrationNumber: reg } });
    const o2 = await open({ place: null, status: "NEW", customer: { type: "organization", registrationNumber: reg } });
    const h1 = await open({ place: null, status: "NEW", contacts: [{ channel: "phone", value: "25400000000" }] });
    const h2 = await open({ place: null, status: "NEW", contacts: [{ channel: "phone", value: "25400000000" }] });
    const single = await open({ place: null, status: "NEW" });

    const numbers = await flagged("duplicate_customers");
    expect(numbers).toEqual(expect.arrayContaining([p1.number, p2.number, n1.number, n2.number, o1.number, o2.number]));
    for (const ok of [h1, h2, single]) expect(numbers).not.toContain(ok.number);

    const groups = await env.admin.accounts.dataQuality.customerDuplicates({ limit: 100 });
    const group = (kind: string, key: string) => groups.items.find((g) => g.matchedOn === kind && g.key === key);
    expect(group("phone", "254711000111")!.customers.map((c) => c.id).sort()).toEqual([p1.customerId, p2.customerId].sort());
    expect(group("national_id", nid)!.customers.flatMap((c) => c.accounts.map((a) => a.number)).sort()).toEqual([n1.number, n2.number].sort());
    expect(group("registration_number", reg)!.customers).toHaveLength(2);
    expect(groups.items.some((g) => g.matchedOn === "phone" && g.key === "")).toBe(false);
  });

  it("customerDuplicates pages by group", async () => {
    const all = await env.admin.accounts.dataQuality.customerDuplicates({ limit: 100 });
    expect(all.items.length).toBeGreaterThanOrEqual(3);
    const seen: string[] = [];
    let after: { matchedOn: "national_id" | "registration_number" | "phone"; key: string } | undefined;
    for (let i = 0; i < 100; i++) {
      const page = await env.admin.accounts.dataQuality.customerDuplicates({ limit: 2, ...(after ? { after } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((g) => `${g.matchedOn}:${g.key}`));
      if (!page.nextCursor) break;
      after = page.nextCursor;
    }
    expect(seen).toEqual(all.items.map((g) => `${g.matchedOn}:${g.key}`));
  });
});

describe("the optional meter rule (Metering's source)", () => {
  it("is skipped with no source or an unlicensed one, and reports the ids a registered source gives", async () => {
    const a = await open();
    const b = await open();
    const draft = await open({ status: "NEW" });
    await expectCode(env.admin.accounts.dataQuality.findings({ rule: "active_metered_no_meter" }), "PRECONDITION_FAILED");
    const without = await env.admin.accounts.dataQuality.summary();
    expect(without.rules.find((r) => r.key === "active_metered_no_meter")).toMatchObject({ state: "no_source", count: null });

    // Licensed only with Metering.
    registerDataQualitySource("active_metered_no_meter", async () => [a.id], { requires: ["metering"] });
    expect((await env.admin.accounts.dataQuality.rules()).find((r) => r.key === "active_metered_no_meter")).toMatchObject({ state: "no_source" });
    await setEntitlements(env.t.app, env.orgA, ["accounts", "metering"]);
    expect((await env.admin.accounts.dataQuality.rules()).find((r) => r.key === "active_metered_no_meter")).toMatchObject({ state: "enabled", hasSource: true });
    expect(await flagged("active_metered_no_meter")).toEqual([a.number]);

    // Only ACTIVE accounts count, even if the source names others.
    registerDataQualitySource("active_metered_no_meter", async () => [a.id, b.id, draft.id, randomUUID()], { requires: ["metering"] });
    expect((await flagged("active_metered_no_meter")).sort()).toEqual([a.number, b.number].sort());
    const summary = await env.admin.accounts.dataQuality.summary();
    expect(summary.rules.find((r) => r.key === "active_metered_no_meter")).toMatchObject({ state: "enabled", count: 2 });
  });
});

describe("summary", () => {
  it("counts every rule from one pass, agrees with the findings, and reports the clean share", async () => {
    await open({ contacts: [] });
    await open({ place: null });
    const summary = await env.admin.accounts.dataQuality.summary();
    expect(summary.examined).toBeGreaterThan(5);
    expect(summary.flagged).toBeGreaterThan(0);
    expect(summary.flagged).toBeLessThanOrEqual(summary.examined);
    expect(summary.clean).toBe(summary.examined - summary.flagged);
    expect(summary.cleanPercent).toBe(Math.round((summary.clean / summary.examined) * 1000) / 10);
    for (const rule of summary.rules.filter((r) => r.count !== null)) {
      expect((await flagged(rule.key)).length, rule.key).toBe(rule.count);
    }
    // An account flagged by several rules counts once in `flagged`.
    const sum = summary.rules.reduce((total, r) => total + (r.count ?? 0), 0);
    expect(summary.flagged).toBeLessThan(sum);
  });

  it("skips terminated accounts and a switched-off rule", async () => {
    const before = await env.admin.accounts.dataQuality.summary();
    const ended = await open({ contacts: [], place: null, status: "NEW" });
    await env.manager().accounts.terminate({ accountId: ended.id, reason: "Gone", acknowledgeNoLedger: true });
    const after = await env.admin.accounts.dataQuality.summary();
    expect(after.examined).toBe(before.examined);
    expect(after.flagged).toBe(before.flagged);

    await configure({ account_no_phone: { enabled: false } });
    const off = await env.admin.accounts.dataQuality.summary();
    expect(off.rules.find((r) => r.key === "account_no_phone")!.count).toBeNull();
    expect(off.flagged).toBeLessThanOrEqual(before.flagged);
  });
});

describe("scope", () => {
  it("a limited member sees counts and findings only inside their scope", async () => {
    const inside = await open({ contacts: [] });
    const outside = await open({ contacts: [], place: { zoneId: env.areas.otherZone, routeId: undefined } });
    const limited = await addMember(env.t, env.orgA, "clerk");
    await env.admin.access.setScope({ userId: limited.userId, areaIds: [env.areas.otherZone], routeIds: [] });
    const caller = env.as(limited);

    const numbers = await flagged("account_no_phone", caller as typeof env.admin);
    expect(numbers).toContain(outside.number);
    expect(numbers).not.toContain(inside.number);
    const mine = await caller.accounts.dataQuality.summary();
    const everyone = await env.admin.accounts.dataQuality.summary();
    expect(mine.examined).toBeLessThan(everyone.examined);
    expect(mine.rules.find((r) => r.key === "account_no_phone")!.count).toBe(numbers.length);

    // Customers the member cannot see are not in the duplicate groups.
    const dup = `ID${randomUUID().slice(0, 8).toUpperCase()}`;
    await open({ place: null, status: "NEW", customer: { nationalId: dup } });
    await open({ place: null, status: "NEW", customer: { nationalId: dup } });
    expect((await caller.accounts.dataQuality.customerDuplicates({ limit: 100 })).items.some((g) => g.key === dup)).toBe(false);
    expect((await env.admin.accounts.dataQuality.customerDuplicates({ limit: 100 })).items.some((g) => g.key === dup)).toBe(true);
  });
});

describe("performance", () => {
  it("passes the report guard (X-04) with facts, a scope and every rule", async () => {
    const facts = { sourceIds: { active_metered_no_meter: [randomUUID()] }, misplaced: [{ s: randomUUID(), z: randomUUID(), d: null, r: randomUUID() }], badCategoryIds: [randomUUID()] };
    const scope = { userId: randomUUID(), areaIds: [env.areas.zone], routeIds: [env.routes.route] };
    await withTenant(env.t.app, env.orgA, async (tx) => {
      expect(await reportPublishProblems(tx, dataQualitySummaryReport.query(dataQualitySummaryReport.params.parse({ facts, scope })))).toEqual([]);
      for (const rule of DATA_QUALITY_RULE_KEYS) {
        expect(await reportPublishProblems(tx, dataQualityFindingsReport.query(dataQualityFindingsReport.params.parse({ rule, facts, scope, exclude: [randomUUID()], after: "10" })))).toEqual([]);
      }
    });
    expect(reports.map((r) => r.key)).toEqual(expect.arrayContaining(["accounts.data_quality_summary", "accounts.data_quality_findings"]));
  });

  it("plans every rule on the indexes: no table is scanned per account", async () => {
    await withTenant(env.t.app, env.orgA, async (tx) => {
      for (const rule of ["account_no_phone", "account_no_service_point", "account_no_coordinates", "duplicate_customers"] as const) {
        const query = dataQualityFindingsReport.query(dataQualityFindingsReport.params.parse({ rule }));
        const plan = JSON.stringify(await tx.execute(sql`explain (format json) ${query}`));
        // Correlated lookups by organization and account or customer use the existing indexes.
        expect(plan, rule).toMatch(/Index|Bitmap/);
      }
    });
  });
});

describe("the exception sweep", () => {
  it("raises nothing until a rule opts in, then one per account and rule, owned and placed; never bumps; resolves when fixed", async () => {
    const lonely = await open({ contacts: [], status: "NEW" });
    expect(await sweepDataQuality(env.t.app)).toBe(0);
    expect(await exceptionsOf("account_no_phone")).toEqual([]);

    await configure({ account_no_phone: { raiseExceptions: true, severity: "critical" } });
    const raised = await sweepDataQuality(env.t.app);
    expect(raised).toBeGreaterThanOrEqual(1);
    const open1 = await exceptionsOf("account_no_phone");
    const mine = open1.find((e) => e.dedupeKey === `dq:account_no_phone:${lonely.id}`)!;
    expect(mine).toMatchObject({
      type: "DATA_QUALITY",
      source: "accounts",
      subjectKind: "account",
      subjectRef: lonely.number,
      status: "open",
      ownerUserId: env.users.clerk,
      areaId: env.areas.zone,
      routeId: env.routes.route,
      occurrences: 1,
    });
    expect(mine.detail).toMatch(/^CRITICAL:/);
    // Other rules did not opt in.
    expect(await exceptionsOf("account_no_coordinates")).toEqual([]);

    // A second run raises nothing new and does not count another occurrence.
    expect(await sweepDataQuality(env.t.app)).toBe(0);
    expect((await exceptionsOf("account_no_phone")).find((e) => e.id === mine.id)).toMatchObject({ occurrences: 1, status: "open" });

    // Fixing the data resolves it by itself.
    await env.clerk().accounts.contacts.add({ customerId: lonely.customerId, channel: "phone", value: "0722 555 666" });
    await sweepDataQuality(env.t.app);
    expect((await exceptionsOf("account_no_phone")).find((e) => e.id === mine.id)).toMatchObject({ status: "resolved" });
    expect((await exceptionsOf("account_no_phone")).find((e) => e.id === mine.id)!.resolutionNote).toMatch(/cleared/);

    // Break it again after it was resolved: a new exception is raised.
    await env.clerk().accounts.contacts.remove({ id: (await env.clerk().accounts.customers.get({ id: lonely.customerId })).contacts[0]!.id });
    await sweepDataQuality(env.t.app);
    const again = (await exceptionsOf("account_no_phone")).filter((e) => e.dedupeKey === `dq:account_no_phone:${lonely.id}`);
    expect(again.map((e) => e.status).sort()).toEqual(["open", "resolved"]);
  });

  it("resolves exceptions when the rule is switched off or stops raising, or the account ends", async () => {
    const a = await open({ contacts: [], status: "NEW" });
    const b = await open({ contacts: [], status: "NEW" });
    await configure({ account_no_phone: { raiseExceptions: true } });
    await sweepDataQuality(env.t.app);
    const isOpen = async (id: string) => (await exceptionsOf("account_no_phone")).some((e) => e.dedupeKey === `dq:account_no_phone:${id}` && e.status !== "resolved");
    expect(await isOpen(a.id)).toBe(true);
    await env.manager().accounts.terminate({ accountId: a.id, reason: "Gone", acknowledgeNoLedger: true });
    await sweepDataQuality(env.t.app);
    expect(await isOpen(a.id)).toBe(false);
    expect(await isOpen(b.id)).toBe(true);

    await configure({ account_no_phone: { raiseExceptions: false } });
    await sweepDataQuality(env.t.app);
    expect(await isOpen(b.id)).toBe(false);
    await configure({ account_no_phone: { raiseExceptions: true, enabled: false } });
    await sweepDataQuality(env.t.app);
    expect(await isOpen(b.id)).toBe(false);
  });

  it("raises at most `limit` per run in account-number order, and the rest on later runs", async () => {
    await configure({ account_no_phone: { raiseExceptions: true } });
    await sweepDataQuality(env.t.app);
    const first = (await exceptionsOf("account_no_phone")).length;
    for (let i = 0; i < 3; i++) await open({ contacts: [], status: "NEW" });
    expect(await sweepDataQuality(env.t.app, { limit: 2 })).toBe(2);
    expect(await sweepDataQuality(env.t.app, { limit: 2 })).toBe(1);
    expect(await sweepDataQuality(env.t.app, { limit: 2 })).toBe(0);
    expect((await exceptionsOf("account_no_phone")).length).toBe(first + 3);
    expect(await sweepDataQuality(env.t.app, { limit: 0 })).toBe(0);
  });

  it("zone_equals_route exceptions carry the reason; the meter rule is left alone while it has no source", async () => {
    await configure({ zone_equals_route: { raiseExceptions: true }, active_metered_no_meter: { raiseExceptions: true } });
    const bad = await open({ place: { routeId: env.routes.otherRoute } });
    await sweepDataQuality(env.t.app);
    const [found] = (await exceptionsOf("zone_equals_route")).filter((e) => e.dedupeKey === `dq:zone_equals_route:${bad.id}`);
    expect(found!.detail).toMatch(/Route 2/);
    expect(found).toMatchObject({ routeId: env.routes.otherRoute, areaId: env.areas.zone });
    expect(await exceptionsOf("active_metered_no_meter")).toEqual([]);

    // With the source registered the meter rule raises too, and clears when the source stops naming the account.
    await setEntitlements(env.t.app, env.orgA, ["accounts", "metering"]);
    registerDataQualitySource("active_metered_no_meter", async () => [bad.id], { requires: ["metering"] });
    await sweepDataQuality(env.t.app);
    expect((await exceptionsOf("active_metered_no_meter")).map((e) => e.status)).toEqual(["open"]);
    registerDataQualitySource("active_metered_no_meter", async () => [], { requires: ["metering"] });
    await sweepDataQuality(env.t.app);
    expect((await exceptionsOf("active_metered_no_meter")).map((e) => e.status)).toEqual(["resolved"]);
  });

  it("does not touch another tenant's accounts or an unlicensed one", async () => {
    await configure({ account_no_phone: { raiseExceptions: true } });
    const outsider = env.outsider();
    const c = await outsider.accounts.customers.create({ type: "person", name: "Outsider customer" });
    const o = await outsider.accounts.create({ customerId: c.id });
    await sweepDataQuality(env.t.app);
    // B never set the setting, so nothing of B's is raised, and A's exceptions never name B's account.
    expect(await env.db.select().from(exception).where(and(eq(exception.subjectRef, o.number), eq(exception.organizationId, env.orgB)))).toEqual([]);
    // Switching Accounts off for A leaves A's open exceptions alone and the sweep still runs.
    await setEntitlements(env.t.app, env.orgA, []);
    await expect(sweepDataQuality(env.t.app)).resolves.toBe(0);
    const stillOpen = await env.db.select().from(exception).where(and(eq(exception.type, "DATA_QUALITY"), eq(exception.organizationId, env.orgA)));
    expect(stillOpen.some((e) => e.status !== "resolved")).toBe(true);
  });
});
