import { withTenant } from "@flowless/db";
import { account, accountCommand } from "@flowless/db/schema/accounts";
import { tariffVersion, tariffVersionLine } from "@flowless/db/schema/tariffs";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consumers } from "../../../kernel/consumers";
import { drainOutbox } from "../../../kernel/events";
import { sweepStaleAccounts } from "..";
import { activationConfigSchema } from "../gates";
import { nextPeriodStartIso } from "../../tariffs/dating";
import { REFERENCE_BANDS, expectCode, increasingContent, setupTariffsEnv, type TariffsEnv } from "../../tariffs/test/test-support";

/*
 * Phase 3 acceptance (docs/build-plan.md → Phase 3 "Done when"), one test per bullet, run end to
 * end through the public procedures against a real database with only Accounts and Tariffs
 * licensed (Work Orders, Inventory, Metering and Billing are off). The isolation canary's
 * coverage of every `accounts` and `tariffs` table is its own test file (`isolation-canary.test.ts`).
 */

let env: TariffsEnv;
beforeAll(async () => {
  env = await setupTariffsEnv();
});
afterAll(() => env?.t.stop());

const drain = () => drainOutbox(env.t.app, consumers);
const ACTIVATION_KEY = "accounts.activation";
async function setSetting(key: string, value: unknown) {
  const current = (await env.admin.config.list()).find((s) => s.key === key)!;
  await env.admin.config.set({ key, value: key === ACTIVATION_KEY ? activationConfigSchema.parse(value) : value, expectedVersion: current.version });
}

describe("Phase 3 acceptance", () => {
  it("only Accounts and Tariffs are licensed; Work Orders and Inventory are off", async () => {
    expect((await env.admin.entitlements.list()).sort()).toEqual(["accounts", "tariffs"]);
    await expectCode(env.admin.workOrders.list(), "NOT_FOUND");
  });

  // Done when 1: an account can go from enquiry to ACTIVE through configurable gates, with Work Orders and Inventory off.
  it("takes an account from enquiry to ACTIVE through configurable gates", async () => {
    const category = await env.admin.tariffs.categories.create({ code: "domestic_acceptance", name: "Domestic (acceptance)" });
    const scheme = await env.admin.hierarchy.createArea({ level: "scheme", code: "ACC", name: "Acceptance scheme" });
    const zone = await env.admin.hierarchy.createArea({ level: "zone", code: "ACC-1", name: "Acceptance zone", parentId: scheme.id });
    const route = await env.admin.hierarchy.createRoute({ code: "ACC-R1", name: "Acceptance route", areaId: zone.id });

    // The meter and initial-reading gates belong to later modules: this organization turns them off, so payment is the one gate.
    await setSetting(ACTIVATION_KEY, { gates: { meter_installed: { enabled: false }, initial_reading: { enabled: false } } });

    const clerk = env.clerk().accounts.applications;
    const { application } = await clerk.create({
      newCustomer: { type: "person", name: "Acceptance Applicant", contacts: [{ channel: "phone", value: "0722 555 001" }] },
      requestedCategoryId: category.id, // checked against Tariffs, which is licensed
      address: "Plot 1, Acceptance zone",
      location: { lat: -1.2, lng: 36.9 },
      schemeId: scheme.id,
      zoneId: zone.id,
      routeId: route.id,
    });
    expect(application.stage).toBe("enquiry");

    // Enquiry to survey: the office records the survey, a manager approves it (a second person), and the stage follows.
    const survey = await clerk.recordSurvey({ applicationId: application.id, feasibility: "feasible", findings: "Main 10 m away" });
    expect(survey.application).toMatchObject({ stage: "enquiry", survey: { approvalState: "pending" } });
    await env.manager().approvals.approve({ id: survey.approval!.id });
    await drain();
    expect((await clerk.get({ id: application.id })).stage).toBe("survey");

    // Survey to converted, with no Work Orders, Inventory, Billing or Payments behind the opaque references.
    await clerk.submitApplication({ applicationId: application.id });
    await clerk.markInvoiced({ applicationId: application.id, invoiceRef: "NC-000001" });
    await clerk.markPaid({ applicationId: application.id, paymentRef: "MPESA-ACC-1" });
    await clerk.startInstallation({ applicationId: application.id });
    await clerk.markReady({ applicationId: application.id });
    const converted = await clerk.convert({ applicationId: application.id });
    expect(converted.application.stage).toBe("converted");
    const accountId = converted.account!.id;
    expect(converted.account).toMatchObject({ commercialStatus: "PENDING_PAYMENT", serviceStatus: "DISCONNECTED" });

    // The configured gates: payment (checklist) is in force, the other two are waived.
    const manager = env.manager().accounts;
    const status = await manager.activation.status({ accountId });
    expect(status.gates.map((g) => [g.key, g.state])).toEqual(
      expect.arrayContaining([["payment_threshold", "unmet"], ["meter_installed", "waived"], ["initial_reading", "waived"]]),
    );
    await expectCode(manager.activate({ accountId, reason: "Too early" }), "PRECONDITION_FAILED");
    await manager.activation.tick({ accountId, gateKey: "payment_threshold", note: "Receipt MPESA-ACC-1" });
    const active = await manager.activate({ accountId, reason: "Gates met" });
    expect(active.account).toMatchObject({ commercialStatus: "ACTIVE", serviceStatus: "CONNECTED" });

    // Configuration, not code: with the payment gate off too, a fresh account activates with nothing ticked.
    await setSetting(ACTIVATION_KEY, { gates: { payment_threshold: { enabled: false }, meter_installed: { enabled: false }, initial_reading: { enabled: false } } });
    const customer = await env.clerk().accounts.customers.create({ type: "person", name: "No Gates Ngugi" });
    const bare = await env.clerk().accounts.create({ customerId: customer.id, categoryId: category.id });
    expect((await manager.activate({ accountId: bare.id, reason: "No gates configured" })).account).toMatchObject({ commercialStatus: "ACTIVE" });
    await setSetting(ACTIVATION_KEY, {});
  });

  // Done when 2: a tariff change effective next period is stored as a new version.
  it("stores a tariff change effective next period as a new version and leaves the old one untouched", async () => {
    const since = env.inDays(-60);
    const created = await env.admin.tariffs.create({ name: "Acceptance block tariff", type: "increasing_block", content: increasingContent(), effectiveFrom: since });
    const before = await versionRows(created.id);
    expect(before.versions).toHaveLength(1);
    expect(before.lines).toHaveLength(REFERENCE_BANDS.length);

    // The change: the first band rises from 82.50 to 95.00, from the next period start (the default).
    const raised = increasingContent(REFERENCE_BANDS.map((b, i) => (i === 0 ? { ...b, rate: 9500n } : b)));
    const added = await env.admin.tariffs.addVersion({ tariffId: created.id, content: raised });
    const periodStart = nextPeriodStartIso(env.today(), { periodStartDay: 1 });
    expect(added).toMatchObject({ versionNo: 2, effectiveFrom: periodStart });

    // A new row; the old version row and its lines are exactly as they were.
    const after = await versionRows(created.id);
    expect(after.versions).toHaveLength(2);
    expect(after.versions.find((v) => v.versionNo === 1)).toEqual(before.versions[0]);
    expect(after.lines.filter((l) => l.versionId === before.versions[0]!.id)).toEqual(before.lines);

    // `inForce` answers the old rates before the effective date and the new ones from it.
    const dayBefore = shift(periodStart, -1);
    const old = await env.admin.tariffs.inForce({ tariffId: created.id });
    expect(old.version).toMatchObject({ versionNo: 1 });
    expect(old.bands?.[0]).toMatchObject({ rate: 8250n });
    expect((await env.admin.tariffs.inForce({ tariffId: created.id, date: dayBefore })).version?.versionNo).toBe(1);
    const next = await env.admin.tariffs.inForce({ tariffId: created.id, date: periodStart });
    expect(next.version).toMatchObject({ versionNo: 2 });
    expect(next.bands?.[0]).toMatchObject({ rate: 9500n });
    expect((await env.admin.tariffs.inForce({ tariffId: created.id, date: since })).version?.versionNo).toBe(1);

    // The database itself refuses to change or remove a version, even for the application's own role.
    const id = before.versions[0]!.id;
    const denied = { cause: { message: expect.stringMatching(/permission denied/) } };
    const asApp = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(env.t.app, env.orgA, fn);
    await expect(asApp((tx) => tx.update(tariffVersion).set({ effectiveFrom: "2030-01-01" }).where(eq(tariffVersion.id, id)))).rejects.toMatchObject(denied);
    await expect(asApp((tx) => tx.delete(tariffVersion).where(eq(tariffVersion.id, id)))).rejects.toMatchObject(denied);
    await expect(asApp((tx) => tx.update(tariffVersionLine).set({ rate: 1n }).where(eq(tariffVersionLine.versionId, id)))).rejects.toMatchObject(denied);
    await expect(asApp((tx) => tx.delete(tariffVersionLine).where(eq(tariffVersionLine.versionId, id)))).rejects.toMatchObject(denied);
    expect((await versionRows(created.id)).versions.find((v) => v.versionNo === 1)).toEqual(before.versions[0]);
  });

  // Done when 3: stale NEW or PENDING_PAYMENT accounts appear in the exception queue.
  it("raises stale NEW and PENDING_PAYMENT accounts in the exception queue and clears them when activated", async () => {
    await setSetting(ACTIVATION_KEY, { staleAfterDays: 10, gates: { payment_threshold: { enabled: false }, meter_installed: { enabled: false }, initial_reading: { enabled: false } } });
    const open = async (name: string) => {
      const customer = await env.clerk().accounts.customers.create({ type: "person", name });
      return env.clerk().accounts.create({ customerId: customer.id });
    };
    const stuckNew = await open("Stale New Njeri");
    const stuckPending = await open("Stale Pending Pauline");
    const fresh = await open("Fresh Fatuma");
    await env.manager().accounts.markPendingPayment({ accountId: stuckPending.id, reason: "Invoice out" });
    await env.manager().accounts.markPendingPayment({ accountId: fresh.id, reason: "Invoice out" });

    // Time passes (the only way to age history is the owner connection, as in the lifecycle tests).
    const old = new Date(Date.now() - 30 * 86_400_000);
    await env.db.update(account).set({ openedAt: old }).where(eq(account.id, stuckNew.id));
    await env.db
      .update(accountCommand)
      .set({ occurredAt: old })
      .where(and(eq(accountCommand.accountId, stuckPending.id), eq(accountCommand.kind, "mark_pending_payment")));

    expect(await sweepStaleAccounts(env.t.app)).toBeGreaterThanOrEqual(2);
    const queue = async (view: "active" | "resolved") => (await env.admin.exceptions.list({ view, type: "STALE_ACTIVATION" })).map((e) => e.subjectRef);
    const active = await queue("active");
    expect(active).toEqual(expect.arrayContaining([stuckNew.number, stuckPending.number]));
    expect(active).not.toContain(fresh.number);
    const raised = (await env.admin.exceptions.list({ view: "active", type: "STALE_ACTIVATION" })).find((e) => e.subjectRef === stuckPending.number)!;
    expect(raised.title).toMatch(/PENDING_PAYMENT/);

    // Activating the accounts takes them out of the queue; the sweep resolves the exceptions by itself.
    await env.manager().accounts.activate({ accountId: stuckNew.id, reason: "Finally connected" });
    await env.manager().accounts.activate({ accountId: stuckPending.id, reason: "Paid" });
    await sweepStaleAccounts(env.t.app);
    const stillActive = await queue("active");
    expect(stillActive).not.toContain(stuckNew.number);
    expect(stillActive).not.toContain(stuckPending.number);
    expect(await queue("resolved")).toEqual(expect.arrayContaining([stuckNew.number, stuckPending.number]));
    await setSetting(ACTIVATION_KEY, {});
  });
});

async function versionRows(tariffId: string) {
  const versions = await env.db.select().from(tariffVersion).where(eq(tariffVersion.tariffId, tariffId)).orderBy(tariffVersion.versionNo);
  const lines = await env.db
    .select()
    .from(tariffVersionLine)
    .where(sql`${tariffVersionLine.versionId} in (select id from tariffs.tariff_version where tariff_id = ${tariffId})`)
    .orderBy(tariffVersionLine.versionId, tariffVersionLine.position);
  return { versions, lines };
}

/** A `YYYY-MM-DD` date shifted by whole days. */
function shift(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
