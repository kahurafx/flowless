import { outboxEvent } from "@flowless/db";
import { account, application, applicationEvent } from "@flowless/db/schema/accounts";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { consumers } from "../../../wiring";
import { setEntitlements } from "../../../kernel/entitlement-store";
import { drainOutbox } from "../../../kernel/events";
import { addMember } from "../../../test-support";
import { registerGateSource } from "..";
import { activationConfigSchema } from "../gates";
import { activationSetting } from "../settings";
import { expectCode, setupAccountsEnv, type AccountsEnv } from "./test-support";

let env: AccountsEnv;
beforeAll(async () => {
  env = await setupAccountsEnv();
});
afterAll(() => env?.t.stop());

const APPLICATION_KEY = "accounts.application";
const SURVEY_POLICY_KEY = "approvals.accounts.connection_survey";
const ONE_LEVEL = [{ label: "Manager", permission: "accounts:change_status" }];
const TWO_LEVELS = [...ONE_LEVEL, { label: "Accountant", permission: "billing:approve" }];

async function setSetting(key: string, value: unknown) {
  const current = (await env.admin.config.list()).find((s) => s.key === key)!;
  await env.admin.config.set({ key, value, expectedVersion: current.version });
}
const setApplicationConfig = (patch: Record<string, unknown> = {}) => setSetting(APPLICATION_KEY, patch);
const setSurveyLevels = (levels: unknown[]) => setSetting(SURVEY_POLICY_KEY, { levels, slaHours: 72 });
const setActivation = (patch: Record<string, unknown>) => setSetting(activationSetting.key, activationConfigSchema.parse(patch));

afterEach(async () => {
  registerGateSource("payment_threshold", null);
  await setApplicationConfig({});
  await setSurveyLevels(ONE_LEVEL);
  await setActivation({});
  await setSetting("accounts.membership", { classes: [] });
  await setEntitlements(env.t.app, env.orgA, ["accounts"]);
});

const drain = () => drainOutbox(env.t.app, consumers);
const appRow = async (id: string) => (await env.db.select().from(application).where(eq(application.id, id)))[0]!;
const historyOf = (id: string) => env.db.select().from(applicationEvent).where(eq(applicationEvent.applicationId, id));
const outbox = async (type: string, key: string, value: string) =>
  (await env.db.select().from(outboxEvent)).filter((e) => e.type === type && (e.payload as Record<string, unknown>)[key] === value);

/** An enquiry by the clerk for a new customer in the DMA's zone. */
function enquiry(extra: Record<string, unknown> = {}, caller = env.clerk()) {
  return caller.accounts.applications.create({
    newCustomer: { type: "person", name: `Applicant ${randomUUID().slice(0, 6)}`, contacts: [{ channel: "phone", value: "0722 123 456" }] },
    address: "Plot 12, Kahawa West",
    location: { lat: -1.2, lng: 36.9 },
    schemeId: env.areas.scheme,
    zoneId: env.areas.zone,
    dmaId: env.areas.dma,
    routeId: env.routes.route,
    ...extra,
  });
}

/** Records a feasible survey and has the manager approve it; the application is then at `survey`. */
async function surveyed(extra: Record<string, unknown> = {}) {
  const { application: a } = await enquiry(extra);
  const survey = await env.clerk().accounts.applications.recordSurvey({
    applicationId: a.id,
    feasibility: "feasible",
    findings: "Main 20 m away, no road crossing",
    materialsNote: "20 m of 25 mm pipe",
  });
  await env.manager().approvals.approve({ id: survey.approval!.id });
  await drain();
  return a.id;
}

// C-05, K-05, K-10: Phase 3 done-when #1, with Work Orders and Inventory unlicensed.
describe("enquiry to ACTIVE with Work Orders and Inventory off", () => {
  it("runs every stage, creates the account and service point, and the F3a checklist activates it", async () => {
    const category = randomUUID();
    const { application: a, replayed } = await enquiry({ requestedCategoryId: category });
    expect(replayed).toBe(false);
    expect(a).toMatchObject({ stage: "enquiry", address: "Plot 12, Kahawa West", schemeId: env.areas.scheme, routeId: env.routes.route });
    const customer = await env.clerk().accounts.customers.get({ id: a.customerId });
    expect(customer.contacts[0]).toMatchObject({ normalized: "254722123456" });
    expect((await env.audit(a.id)).map((e) => e.action)).toEqual(["accounts.application_create"]);

    // No skipping: a required stage cannot be passed.
    await expectCode(env.clerk().accounts.applications.submitApplication({ applicationId: a.id }), "PRECONDITION_FAILED");
    await expectCode(env.clerk().accounts.applications.markPaid({ applicationId: a.id, paymentRef: "X" }), "PRECONDITION_FAILED");
    await expectCode(env.clerk().accounts.applications.convert({ applicationId: a.id }), "PRECONDITION_FAILED");

    const survey = await env.clerk().accounts.applications.recordSurvey({ applicationId: a.id, feasibility: "feasible", findings: "Main 20 m away" });
    expect(survey.application).toMatchObject({ stage: "enquiry", survey: { feasibility: "feasible", approvalState: "pending" } });
    // The survey waits for approval; the person who recorded it cannot approve, and a re-record is refused.
    await expectCode(env.clerk().approvals.approve({ id: survey.approval!.id }), "FORBIDDEN");
    await expectCode(env.clerk().accounts.applications.recordSurvey({ applicationId: a.id, feasibility: "feasible", findings: "Again" }), "PRECONDITION_FAILED");
    await env.manager().approvals.approve({ id: survey.approval!.id, note: "Looks right" });
    await drain();
    expect(await appRow(a.id)).toMatchObject({ stage: "survey", surveyApprovalState: "approved" });
    await drain();
    expect((await historyOf(a.id)).filter((e) => e.kind === "stage_changed" && e.toStage === "survey")).toHaveLength(1);

    const c = env.clerk().accounts.applications;
    await c.submitApplication({ applicationId: a.id });
    await expectCode(c.markInvoiced({ applicationId: a.id, invoiceRef: "" }), "BAD_REQUEST");
    expect((await c.markInvoiced({ applicationId: a.id, invoiceRef: "INV-0001" })).application).toMatchObject({ stage: "invoice", invoiceRef: "INV-0001" });
    expect((await c.markPaid({ applicationId: a.id, paymentRef: "MPESA-XYZ" })).application).toMatchObject({ stage: "payment", paymentRef: "MPESA-XYZ" });
    await c.startInstallation({ applicationId: a.id });
    await c.markReady({ applicationId: a.id });

    const converted = await c.convert({ applicationId: a.id });
    expect(converted.application).toMatchObject({ stage: "converted", accountId: converted.account!.id, servicePointId: converted.servicePoint!.id });
    expect(converted.account).toMatchObject({ commercialStatus: "PENDING_PAYMENT", serviceStatus: "DISCONNECTED", customerId: a.customerId });
    expect(converted.servicePoint).toMatchObject({ address: "Plot 12, Kahawa West", schemeId: env.areas.scheme, zoneId: env.areas.zone, dmaId: env.areas.dma, routeId: env.routes.route });
    await expectCode(c.convert({ applicationId: a.id }), "PRECONDITION_FAILED");
    await expectCode(c.reject({ applicationId: a.id, reason: "No" }), "PRECONDITION_FAILED");

    // The account's log shows the F3a command that put it in PENDING_PAYMENT.
    const log = await env.clerk().accounts.commands.list({ accountId: converted.account!.id });
    expect(log.map((x) => x.kind)).toEqual(["mark_pending_payment"]);
    expect((await outbox("accounts.application_converted", "applicationId", a.id))[0]!.payload).toMatchObject({ accountId: converted.account!.id, categoryId: category });

    // Activation is F3a's gates: the office checklist, with no Work Orders, Inventory or Metering behind it.
    await setActivation({ gates: { meter_installed: { enabled: false } } });
    const manager = env.manager();
    await expectCode(manager.accounts.activate({ accountId: converted.account!.id, reason: "Go" }), "PRECONDITION_FAILED");
    await manager.accounts.activation.tick({ accountId: converted.account!.id, gateKey: "payment_threshold", note: "Receipt MPESA-XYZ" });
    await manager.accounts.activation.tick({ accountId: converted.account!.id, gateKey: "initial_reading" });
    const active = await manager.accounts.activate({ accountId: converted.account!.id, reason: "Gates met" });
    expect(active.account).toMatchObject({ commercialStatus: "ACTIVE", serviceStatus: "CONNECTED" });

    // The stage history is the application's append-only log.
    const stages = (await historyOf(a.id)).filter((e) => e.kind === "stage_changed").map((e) => `${e.fromStage ?? "-"}>${e.toStage}`);
    expect(stages).toEqual(expect.arrayContaining(["enquiry>survey", "survey>application", "application>invoice", "invoice>payment", "payment>installation", "installation>ready", "ready>converted"]));
    const got = await env.clerk().accounts.applications.get({ id: a.id });
    expect(got.events.map((e) => e.kind)).toContain("survey_recorded");
    expect((await outbox("accounts.application_stage_changed", "applicationId", a.id)).length).toBeGreaterThanOrEqual(8);
  });

  it("uses a waived stage as configuration, not code (survey, invoice and installation off)", async () => {
    await setApplicationConfig({ survey: { required: false }, invoice: { required: false }, installation: { required: false } });
    const { application: a } = await enquiry();
    const c = env.clerk().accounts.applications;
    await expectCode(c.recordSurvey({ applicationId: a.id, feasibility: "feasible", findings: "x" }), "PRECONDITION_FAILED");
    await expectCode(c.markInvoiced({ applicationId: a.id, invoiceRef: "X" }), "PRECONDITION_FAILED");
    expect((await env.clerk().accounts.applications.stages()).stages).toEqual(["enquiry", "application", "ready", "converted"]);
    await c.submitApplication({ applicationId: a.id });
    await c.markReady({ applicationId: a.id });
    const converted = await c.convert({ applicationId: a.id });
    // Without the new-connection invoice the account stays NEW.
    expect(converted.account).toMatchObject({ commercialStatus: "NEW" });
    expect(await env.clerk().accounts.commands.list({ accountId: converted.account!.id })).toHaveLength(0);
  });

  it("converts a child connection under its parent with a membership class", async () => {
    await setSetting("accounts.membership", { classes: [{ key: "member", label: "Member", connectionFeeChargeItemCode: "connection_member" }] });
    const parentCustomer = await env.person(env.clerk());
    const parent = await env.clerk().accounts.create({ customerId: parentCustomer.id });
    const id = await surveyed({ parentAccountId: parent.id, membershipClass: "member" });
    const c = env.clerk().accounts.applications;
    await c.submitApplication({ applicationId: id });
    await c.markInvoiced({ applicationId: id, invoiceRef: "I" });
    await c.markPaid({ applicationId: id, paymentRef: "P" });
    await c.startInstallation({ applicationId: id });
    await c.markReady({ applicationId: id });
    const converted = await c.convert({ applicationId: id });
    expect(converted.account).toMatchObject({ parentAccountId: parent.id, membershipClass: "member", number: `${parent.number}A` });
    await expectCode(enquiry({ membershipClass: "member" }), "BAD_REQUEST");
    await expectCode(enquiry({ parentAccountId: parent.id, membershipClass: "nope" }), "BAD_REQUEST");
  });
});

// K-05: the survey's approval is policy, with 0, 1 or 2 levels.
describe("survey approval (K-05)", () => {
  it("needs no approval when the policy has no level", async () => {
    await setSurveyLevels([]);
    const { application: a } = await enquiry();
    const survey = await env.clerk().accounts.applications.recordSurvey({ applicationId: a.id, feasibility: "feasible", findings: "Easy" });
    expect(survey.application).toMatchObject({ stage: "survey", survey: { approvalState: "approved" } });
    expect(survey.approval!.status).toBe("approved");
    await drain();
    expect((await historyOf(a.id)).filter((e) => e.kind === "stage_changed" && e.toStage === "survey")).toHaveLength(1);
  });

  it("with two levels needs two different people, never the requester", async () => {
    await setSurveyLevels(TWO_LEVELS);
    const { application: a } = await enquiry();
    const { approval } = await env.clerk().accounts.applications.recordSurvey({ applicationId: a.id, feasibility: "feasible", findings: "Needs two" });
    // Level 1 is accounts:change_status: the requester (a clerk) has no right; the accountant is level 2 only.
    await expectCode(env.clerk().approvals.approve({ id: approval!.id }), "FORBIDDEN");
    await expectCode(env.accountant().approvals.approve({ id: approval!.id }), "FORBIDDEN");
    await env.manager().approvals.approve({ id: approval!.id });
    await drain();
    expect((await appRow(a.id)).stage, "still waiting for level 2").toBe("enquiry");
    // The same person cannot decide the second level too.
    await expectCode(env.manager().approvals.approve({ id: approval!.id }), "FORBIDDEN");
    await env.accountant().approvals.approve({ id: approval!.id });
    await drain();
    expect(await appRow(a.id)).toMatchObject({ stage: "survey", surveyApprovalState: "approved" });
  });

  it("cannot be approved by the person who recorded it, even a manager", async () => {
    const { application: a } = await enquiry({}, env.manager());
    const { approval } = await env.manager().accounts.applications.recordSurvey({ applicationId: a.id, feasibility: "feasible", findings: "Mine" });
    await expectCode(env.manager().approvals.approve({ id: approval!.id }), "FORBIDDEN");
    await env.admin.approvals.approve({ id: approval!.id });
    await drain();
    expect((await appRow(a.id)).stage).toBe("survey");
  });

  it("a rejected survey keeps the application at the enquiry until a new survey is recorded", async () => {
    const { application: a } = await enquiry();
    const first = await env.clerk().accounts.applications.recordSurvey({ applicationId: a.id, feasibility: "feasible", findings: "First" });
    await env.manager().approvals.reject({ id: first.approval!.id, note: "Measure again" });
    await drain();
    expect(await appRow(a.id)).toMatchObject({ stage: "enquiry", surveyApprovalState: "rejected" });
    await expectCode(env.clerk().accounts.applications.submitApplication({ applicationId: a.id }), "PRECONDITION_FAILED");
    const second = await env.clerk().accounts.applications.recordSurvey({ applicationId: a.id, feasibility: "feasible", findings: "Second" });
    // A late delivery for the first request changes nothing.
    await env.manager().approvals.approve({ id: second.approval!.id });
    await drain();
    await drain();
    expect(await appRow(a.id)).toMatchObject({ stage: "survey", surveyApprovalId: second.approval!.id });
    expect((await historyOf(a.id)).filter((e) => e.kind === "survey_decided")).toHaveLength(1);
  });

  it("records a survey that is not feasible without asking for approval, and the office rejects", async () => {
    const { application: a } = await enquiry();
    const survey = await env.clerk().accounts.applications.recordSurvey({ applicationId: a.id, feasibility: "not_feasible", findings: "Main is 2 km away" });
    expect(survey.approval).toBeNull();
    await expectCode(env.clerk().accounts.applications.submitApplication({ applicationId: a.id }), "PRECONDITION_FAILED");
    const rejected = await env.clerk().accounts.applications.reject({ applicationId: a.id, reason: "Not feasible" });
    expect(rejected.application.stage).toBe("rejected");
    await expectCode(env.clerk().accounts.applications.cancel({ applicationId: a.id, reason: "Changed mind" }), "PRECONDITION_FAILED");
    await expectCode(env.clerk().accounts.applications.recordSurvey({ applicationId: a.id, feasibility: "feasible", findings: "x" }), "PRECONDITION_FAILED");
  });
});

// W-01, W-03: with Work Orders licensed the survey can be a job; the office path always works.
describe("survey as a work order", () => {
  it("offers the kinds only with Work Orders, and a completed job records the survey on its application", async () => {
    const tech = await addMember(env.t, env.orgA, "technician");
    const kinds = async () => {
      try {
        return (await env.admin.workOrders.kinds()).map((k) => k.key);
      } catch {
        return [] as string[]; // Work Orders is not licensed
      }
    };
    expect(await kinds()).not.toContain("connection_survey");

    await setEntitlements(env.t.app, env.orgA, ["accounts", "work-orders"]);
    expect(await kinds()).toEqual(expect.arrayContaining(["connection_survey", "relocation"]));
    const kind = (await env.admin.workOrders.kinds()).find((k) => k.key === "connection_survey")!;
    expect(kind.captureSchema).toBeTruthy();

    const { application: a } = await enquiry();
    const job = await env.admin.workOrders.create({
      kind: "connection_survey",
      title: "Survey Plot 12",
      assetId: a.id,
      location: { latitude: -1.2, longitude: 36.9 },
      assigneeId: tech.userId,
    });
    expect(job).toMatchObject({ kind: "connection_survey" });
    const asTech = env.as(tech);
    const done = await asTech.workOrders.transition({
      eventId: randomUUID(),
      workOrderId: job.id,
      action: { type: "complete", outcome: "done", capture: { feasibility: "feasible", findings: "Main 15 m away", materials: "15 m pipe" } },
      position: { latitude: -1.2, longitude: 36.9 },
    });
    expect(done.outcome).toBe("applied");
    expect(await outbox("accounts.connection_survey_completed", "workOrderId", job.id)).toHaveLength(1);

    await drain();
    const recorded = await appRow(a.id);
    expect(recorded).toMatchObject({
      surveyFeasibility: "feasible",
      surveyFindings: "Main 15 m away",
      surveyMaterials: "15 m pipe",
      surveySource: "work_order",
      surveyWorkOrderId: job.id,
      surveyApprovalState: "pending",
      stage: "enquiry",
    });
    // The approval is requested as the technician who did the job; the manager approves it.
    await env.manager().approvals.approve({ id: recorded.surveyApprovalId! });
    await drain();
    await drain();
    expect((await appRow(a.id)).stage).toBe("survey");
    expect((await historyOf(a.id)).filter((e) => e.kind === "survey_recorded")).toHaveLength(1);
    expect((await historyOf(a.id)).find((e) => e.kind === "survey_recorded")).toMatchObject({ source: "system" });
  });

  it("leaves the job alone when the application was surveyed by hand", async () => {
    await setEntitlements(env.t.app, env.orgA, ["accounts", "work-orders"]);
    const tech = await addMember(env.t, env.orgA, "technician");
    const { application: a } = await enquiry();
    await setSurveyLevels([]);
    await env.clerk().accounts.applications.recordSurvey({ applicationId: a.id, feasibility: "feasible", findings: "By hand" });
    const job = await env.admin.workOrders.create({ kind: "connection_survey", title: "Late job", assetId: a.id, location: { latitude: -1.2, longitude: 36.9 }, assigneeId: tech.userId });
    await env.as(tech).workOrders.transition({
      eventId: randomUUID(),
      workOrderId: job.id,
      action: { type: "complete", outcome: "done", capture: { feasibility: "not_feasible", findings: "Too late" } },
      position: { latitude: -1.2, longitude: 36.9 },
    });
    await drain();
    expect(await appRow(a.id)).toMatchObject({ surveyFindings: "By hand", stage: "survey" });
  });
});

describe("idempotency, permissions, scope and tenancy", () => {
  it("returns the earlier result for a repeated client id and refuses a different request under it", async () => {
    const id = randomUUID();
    const first = await enquiry({ id });
    const again = await enquiry({ id, newCustomer: { type: "person", name: "Someone Else", contacts: [] } });
    expect([again.replayed, again.application.id, again.application.customerId]).toEqual([true, id, first.application.customerId]);
    await expectCode(enquiry({ id }, env.manager()), "CONFLICT");

    const c = env.clerk().accounts.applications;
    const surveyId = randomUUID();
    const s1 = await c.recordSurvey({ id: surveyId, applicationId: id, feasibility: "feasible", findings: "F" });
    const s2 = await c.recordSurvey({ id: surveyId, applicationId: id, feasibility: "feasible", findings: "F" });
    expect([s1.replayed, s2.replayed, s2.approval!.id]).toEqual([false, true, s1.approval!.id]);
    await expectCode(c.recordSurvey({ id: surveyId, applicationId: id, feasibility: "feasible", findings: "Different" }), "CONFLICT");

    await setSurveyLevels([]);
    const { application: b } = await enquiry();
    await c.recordSurvey({ applicationId: b.id, feasibility: "feasible", findings: "F" });
    const stepId = randomUUID();
    const submitted = await c.submitApplication({ id: stepId, applicationId: b.id });
    const replay = await c.submitApplication({ id: stepId, applicationId: b.id });
    expect([submitted.replayed, replay.replayed, replay.application.stage]).toEqual([false, true, "application"]);
    await expectCode(c.submitApplication({ id: stepId, applicationId: id }), "CONFLICT");
    await expectCode(c.reject({ id: stepId, applicationId: b.id, reason: "Different" }), "CONFLICT");
    expect((await historyOf(b.id)).filter((e) => e.toStage === "application")).toHaveLength(1);
  });

  it("converts once, even when two converts race", async () => {
    await setApplicationConfig({ survey: { required: false }, invoice: { required: false }, installation: { required: false } });
    const { application: a } = await enquiry();
    const c = env.clerk().accounts.applications;
    await c.submitApplication({ applicationId: a.id });
    await c.markReady({ applicationId: a.id });
    const results = await Promise.allSettled([c.convert({ applicationId: a.id }), c.convert({ applicationId: a.id })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await env.db.select().from(account).where(eq(account.customerId, a.customerId)))).toHaveLength(1);
    const same = randomUUID();
    const { application: b } = await enquiry();
    await c.submitApplication({ applicationId: b.id });
    await c.markReady({ applicationId: b.id });
    const first = await c.convert({ id: same, applicationId: b.id });
    const second = await c.convert({ id: same, applicationId: b.id });
    expect([second.replayed, second.account!.id]).toEqual([true, first.account!.id]);
  });

  it("checks the category with Tariffs only while Tariffs is licensed", async () => {
    const unknown = randomUUID();
    await expect(enquiry({ requestedCategoryId: unknown })).resolves.toBeTruthy();
    await setEntitlements(env.t.app, env.orgA, ["accounts", "tariffs"]);
    await expectCode(enquiry({ requestedCategoryId: unknown }), "BAD_REQUEST");
    const category = await env.admin.tariffs.categories.create({ code: "app_test", name: "Application test" });
    expect((await enquiry({ requestedCategoryId: category.id })).application.requestedCategoryId).toBe(category.id);
    await env.admin.tariffs.categories.deactivate({ id: category.id });
    await expectCode(enquiry({ requestedCategoryId: category.id }), "BAD_REQUEST");
  });

  it("gives each role only its part of the workflow", async () => {
    const { application: a } = await enquiry();
    for (const caller of [env.cashier(), env.supervisor()]) {
      expect((await caller.accounts.applications.get({ id: a.id })).id).toBe(a.id);
      expect(await caller.accounts.applications.list()).toBeTruthy();
      await expectCode(enquiry({}, caller), "FORBIDDEN");
      await expectCode(caller.accounts.applications.recordSurvey({ applicationId: a.id, feasibility: "feasible", findings: "x" }), "FORBIDDEN");
      await expectCode(caller.accounts.applications.submitApplication({ applicationId: a.id }), "FORBIDDEN");
      await expectCode(caller.accounts.applications.reject({ applicationId: a.id, reason: "No" }), "FORBIDDEN");
      await expectCode(caller.accounts.applications.convert({ applicationId: a.id }), "FORBIDDEN");
    }
    // An update-only grant can record a survey but not convert.
    const updater = await addMember(env.t, env.orgA, "member");
    await env.admin.access.grant({ userId: updater.userId, permission: "accounts:update" });
    await expect(env.as(updater).accounts.applications.recordSurvey({ applicationId: a.id, feasibility: "not_feasible", findings: "x" })).resolves.toBeTruthy();
    await expectCode(env.as(updater).accounts.applications.convert({ applicationId: a.id }), "FORBIDDEN");
  });

  it("limits a scoped member to applications inside their scope", async () => {
    const limited = await addMember(env.t, env.orgA, "clerk");
    await env.admin.access.setScope({ userId: limited.userId, areaIds: [env.areas.otherZone], routeIds: [] });
    const own = env.as(limited);
    await expectCode(enquiry({}, own), "FORBIDDEN");
    const mine = await enquiry({ schemeId: env.areas.scheme, zoneId: env.areas.otherZone, dmaId: undefined, routeId: undefined }, own);
    const theirs = await enquiry();
    expect((await own.accounts.applications.get({ id: mine.application.id })).id).toBe(mine.application.id);
    await expectCode(own.accounts.applications.get({ id: theirs.application.id }), "NOT_FOUND");
    await expectCode(own.accounts.applications.submitApplication({ applicationId: theirs.application.id }), "NOT_FOUND");
    expect((await own.accounts.applications.list()).map((x) => x.id)).not.toContain(theirs.application.id);
    // An enquiry with no place yet belongs to whoever made it: another scoped member does not see it.
    const unplaced = await own.accounts.applications.create({ newCustomer: { type: "person", name: "Walk-in", contacts: [] }, address: "Somewhere" });
    expect((await own.accounts.applications.get({ id: unplaced.application.id })).id).toBe(unplaced.application.id);
    const other = await addMember(env.t, env.orgA, "clerk");
    await env.admin.access.setScope({ userId: other.userId, areaIds: [env.areas.otherZone], routeIds: [] });
    await expectCode(env.as(other).accounts.applications.get({ id: unplaced.application.id }), "NOT_FOUND");
    expect((await env.as(other).accounts.applications.get({ id: mine.application.id })).id).toBe(mine.application.id);
  });

  it("does not reach another tenant and is NOT_FOUND without the licence", async () => {
    const { application: a } = await enquiry();
    await expectCode(env.outsider().accounts.applications.get({ id: a.id }), "NOT_FOUND");
    await expectCode(env.outsider().accounts.applications.reject({ applicationId: a.id, reason: "x" }), "NOT_FOUND");
    expect(await env.outsider().accounts.applications.list()).toEqual([]);
    await expectCode(env.bare().accounts.applications.list(), "NOT_FOUND");
    await expectCode(env.bare().accounts.applications.create({ customerId: randomUUID(), address: "x" }), "NOT_FOUND");
  });

  it("refuses to change a stage or delete history behind the use cases' back", async () => {
    const { application: a } = await enquiry();
    // Stage moves need an event describing them (trigger), and history is append-only (grants).
    await expect(env.db.update(application).set({ stage: "invoice" }).where(eq(application.id, a.id))).rejects.toThrow();
    await expect(env.t.app.execute(sql`update accounts.application_event set reason = 'x'`)).rejects.toThrow();
    await expect(env.t.app.execute(sql`delete from accounts.application`)).rejects.toThrow();
  });
});
