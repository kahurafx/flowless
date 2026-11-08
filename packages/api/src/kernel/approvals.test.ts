import { approvalDecision, approvalRequest, auditLog, consumerReceipt, exception, outboxEvent, withTenant } from "@flowless/db";
import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { addMember, callerFor, sessionOf, type Member } from "../test-support";
import { createCallerFactory, router, tenantProcedure } from "../trpc";
import {
  approvalPolicySetting,
  defineApproval,
  defineApprovalConsumer,
  escalateApprovals,
  type ApprovalDecided,
} from "./approval-store";
import { createApprovalsRouter } from "./approvals";
import { createConfigRouter } from "./config";
import type { SettingDef } from "./config-store";
import { drainOutbox, type Consumer } from "./events";

// D-04: a rebate is approved by an accountant, then (above KES 5,000) by a manager.
const rebate = defineApproval({
  key: "kernel.test_rebate",
  module: "kernel",
  label: "Rebate",
  description: "A credit to a customer after a dispute.",
  reasonCodes: [
    { code: "METER_FAULT", label: "Faulty meter" },
    { code: "LEAK_AFTER_METER", label: "Leak after the meter" },
  ],
  policy: {
    levels: [
      { label: "Accountant", permission: "collections:approve_rebate" },
      { label: "Manager", permission: "collections:manage", minAmount: "500000" },
    ],
    slaHours: 24,
    escalateTo: "settings:manage",
  },
});

const testRouter = router({
  approvals: createApprovalsRouter([rebate]),
  config: createConfigRouter([approvalPolicySetting(rebate) as SettingDef]),
  ask: tenantProcedure
    .input(z.object({ ref: z.string(), amount: z.bigint().optional(), reason: z.string().optional(), areaId: z.uuid().optional() }))
    .mutation(({ ctx, input }) =>
      ctx.requestApproval(rebate, {
        subjectRef: input.ref,
        title: `Rebate on ${input.ref}`,
        amount: input.amount ?? null,
        reasonCode: input.reason ?? "METER_FAULT",
        note: "Customer disputed the November bill",
        payload: { account: input.ref },
        areaId: input.areaId ?? null,
      }),
    ),
});

let t: TestDatabase;
let clerk: Member;
let accountant: Member;
let manager: Member;
let owner: Member;
let technician: Member;
beforeAll(async () => {
  t = await startTestDatabase();
  clerk = await addMember(t, tenants.a.id, "clerk");
  accountant = await addMember(t, tenants.a.id, "accountant");
  manager = await addMember(t, tenants.a.id, "manager");
  owner = await addMember(t, tenants.a.id, "owner");
  technician = await addMember(t, tenants.a.id, "technician");
});
afterAll(() => t?.stop());
beforeEach(async () => {
  await t.admin.delete(approvalDecision);
  await t.admin.delete(approvalRequest);
  await t.admin.delete(exception);
  await t.admin.delete(consumerReceipt);
  await t.admin.delete(outboxEvent);
  await t.admin.execute(sql`delete from kernel.config_version where key like 'approvals.%'`);
});

const as = (m: Member) => createCallerFactory(testRouter)({ db: t.app, session: sessionOf(m) });
const KES = (shillings: number) => BigInt(shillings * 100);

/** Delivers outbox events to a consumer that records outcomes of this kind. */
async function outcomes(): Promise<ApprovalDecided[]> {
  const seen: ApprovalDecided[] = [];
  const consumer = defineApprovalConsumer(rebate, `test.rebate_${Math.random()}`, async (_ctx, decided) => {
    seen.push(decided);
  });
  await drainOutbox(t.app, [consumer as Consumer]);
  return seen;
}

// K-05: N-level approvals with thresholds, reason codes, SLA and escalation.
describe("approvals", () => {
  it("skip levels below their threshold, and publish the outcome", async () => {
    const { id, status } = await as(clerk).ask({ ref: "1008-4", amount: KES(1200) });
    expect(status).toBe("pending");
    const [waiting] = await as(accountant).approvals.list();
    expect(waiting).toMatchObject({ id, levels: ["Accountant"], waitingFor: "Accountant", reasonLabel: "Faulty meter", canDecide: true });

    expect(await as(accountant).approvals.approve({ id })).toEqual({ status: "approved", level: 0 });
    expect(await outcomes()).toEqual([
      { requestId: id, kind: rebate.key, subjectRef: "1008-4", outcome: "approved", amount: "120000", payload: { account: "1008-4" } },
    ]);
  });

  it("take every level in turn above the threshold, each by a different person", async () => {
    const { id } = await as(clerk).ask({ ref: "1009", amount: KES(8000) });
    await expect(as(manager).approvals.list()).resolves.toHaveLength(1);
    await as(owner).approvals.approve({ id, note: "Meter test confirmed" });

    const [atManager] = await as(manager).approvals.list();
    expect(atManager).toMatchObject({ id, level: 1, waitingFor: "Manager" });
    expect(await as(accountant).approvals.list()).toEqual([]);
    await expect(as(accountant).approvals.approve({ id })).rejects.toMatchObject({ code: "FORBIDDEN", message: "Needs collections:manage" });
    await expect(as(owner).approvals.approve({ id })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You already approved an earlier level of this request",
    });
    await as(manager).approvals.approve({ id });

    const detail = await as(clerk).approvals.get({ id });
    expect(detail).toMatchObject({ status: "approved", canDecide: false });
    expect(detail.decisions.map((d) => [d.level, d.decision, d.byUserId])).toEqual([
      [0, "approve", owner.userId],
      [1, "approve", manager.userId],
    ]);
    const actions = await t.admin
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.subjectType, "approval"), eq(auditLog.subjectId, id)))
      .orderBy(auditLog.chainIndex);
    expect(actions.map((a) => a.action)).toEqual(["approvals.request", "approvals.approve", "approvals.approve"]);
  });

  it("never let the requester decide, need a reason to ask and a note to reject", async () => {
    await expect(as(clerk).ask({ ref: "1010", reason: "BECAUSE" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Choose a reason" });
    const { id } = await as(owner).ask({ ref: "1010", amount: KES(100) });
    await expect(as(owner).approvals.approve({ id })).rejects.toMatchObject({ code: "FORBIDDEN", message: "You can't decide your own request" });
    await expect(as(accountant).approvals.reject({ id, note: " " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await as(accountant).approvals.reject({ id, note: "No meter test on file" });
    await expect(as(manager).approvals.approve({ id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await outcomes()).map((o) => o.outcome)).toEqual(["rejected"]);
    expect(await callerFor(t, owner).notifications.list()).toEqual([
      expect.objectContaining({ topic: "approvals.rejected", title: "Rejected: Rebate on 1010", body: "No meter test on file" }),
    ]);
  });

  it("allow one pending request per subject; the requester can withdraw it", async () => {
    const { id } = await as(clerk).ask({ ref: "1011" });
    await expect(as(clerk).ask({ ref: "1011" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(as(accountant).approvals.cancel({ id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await as(clerk).approvals.cancel({ id, note: "Raised on the wrong account" });
    expect((await outcomes()).map((o) => o.outcome)).toEqual(["cancelled"]);
    await expect(as(clerk).ask({ ref: "1011" })).resolves.toMatchObject({ status: "pending" });
  });

  it("follow the organization's policy, fixed per request when it is made (K-10)", async () => {
    const before = await as(clerk).ask({ ref: "1012", amount: KES(8000) });
    await as(owner).config.set({
      key: "approvals.kernel.test_rebate",
      value: { levels: [{ label: "Accountant", permission: "collections:approve_rebate", minAmount: "200000" }], slaHours: 4 },
      expectedVersion: 0,
    });
    // Under KES 2,000 nobody needs to look at it any more.
    expect(await as(clerk).ask({ ref: "1013", amount: KES(500) })).toMatchObject({ status: "approved" });
    expect((await as(owner).approvals.get({ id: before.id })).levels).toEqual(["Accountant", "Manager"]);

    await expect(
      as(owner).config.set({
        key: "approvals.kernel.test_rebate",
        value: { levels: [{ label: "Nobody", permission: "rebates:approve" }] },
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Unknown permission" });
  });

  it("escalate past the SLA into the exception queue, then let the escalation permission decide", async () => {
    const scheme = await callerFor(t, owner).hierarchy.createArea({ level: "scheme", code: "APS", name: "Approval scheme" });
    const { id } = await as(clerk).ask({ ref: "1014", areaId: scheme.id });
    expect(await escalateApprovals(t.app)).toBe(0);

    await t.admin.update(approvalRequest).set({ dueAt: new Date(Date.now() - 1000) }).where(eq(approvalRequest.id, id));
    expect(await escalateApprovals(t.app)).toBe(1);
    expect(await escalateApprovals(t.app)).toBe(0);
    const [overdue] = await callerFor(t, owner).exceptions.list({ type: "APPROVAL_OVERDUE" });
    expect(overdue).toMatchObject({ title: "Approval overdue: Rebate on 1014", subjectKind: "approval", subjectRef: id, areaId: scheme.id });
    expect(overdue!.detail).toMatch(/more than 24 hours\. Members with settings:manage may now decide it/);

    // An admin without the rebate permission steps in once it is overdue.
    const admin = await addMember(t, tenants.a.id, "admin");
    await t.admin.execute(sql`update auth.member set role = 'clerk' where user_id = ${admin.userId}`);
    await callerFor(t, owner).access.grant({ userId: admin.userId, permission: "settings:manage" });
    const stepIn = { ...admin, role: "clerk" };
    expect((await as(stepIn).approvals.list()).map((r) => r.id)).toEqual([id]);
    await as(stepIn).approvals.approve({ id, note: "Accountant on leave" });
    expect(await callerFor(t, owner).exceptions.list({ type: "APPROVAL_OVERDUE" })).toEqual([]);
  });

  it("show only requests a member is involved in, never another tenant's", async () => {
    const { id } = await as(clerk).ask({ ref: "1015" });
    expect(await as(technician).approvals.list({ view: "open" })).toEqual([]);
    await expect(as(technician).approvals.get({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const ownerB = await addMember(t, tenants.b.id, "owner");
    expect(await as(ownerB).approvals.list({ view: "open" })).toEqual([]);
    await expect(as(ownerB).approvals.approve({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(withTenant(t.app, tenants.a.id, (tx) => tx.delete(approvalDecision))).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/permission denied/) },
    });
  });
});
