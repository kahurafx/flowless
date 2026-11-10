import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drainOutbox } from "../../../kernel/events";
import { runJobs, type JobDef } from "../../../kernel/jobs";
import { consumers, jobs } from "../../../wiring";
import { derivedId } from "../disconnections";
import { expectCode, setupBillingEnv, type BillingEnv } from "./test-support";

// P5-5: disconnection and reconnection (B-12), corrections (B-13, B-14), revenue cases (B-19), status blocks (B-09).

let env: BillingEnv;
let schemeId: string;
let feeItem: string;
const at = (iso: string) => new Date(`${iso}T08:00:00Z`);

beforeAll(async () => {
  env = await setupBillingEnv({ metering: true });
  schemeId = (await env.admin.hierarchy.createArea({ level: "scheme", code: "S1", name: "Scheme" })).id;
  const current = (await env.admin.config.list()).find((s) => s.key === "billing.policy");
  await env.admin.config.set({ key: "billing.policy", value: { ...(current?.value as object), usageInvoiceTypeCode: "water_bill" }, expectedVersion: current?.version ?? 0 });
  const fee = await env.admin.tariffs.chargeItems.create({ code: "turn_off", name: "Turn-off fee", type: "fee", amount: 50_000n });
  await env.admin.tariffs.chargeItems.addAmountVersion({ chargeItemId: fee.id, amount: 50_000n, effectiveFrom: "2020-01-01" });
  feeItem = fee.id;
});
afterAll(() => env?.t.stop());

const newRoute = async () => (await env.admin.hierarchy.createRoute({ code: `R-${randomUUID().slice(0, 6)}`, name: "Route" })).id;
const HISTORY: [string, number][] = [["2024-12-31", 105], ["2025-01-31", 115], ["2025-02-27", 130]];

/** An ACTIVE, CONNECTED account with a meter (initial 100 on 2024-12-01) and the given readings. */
async function account(routeId: string, readings: [string, number][] = HISTORY) {
  const customer = await env.admin.accounts.customers.create({ type: "person", name: `Holder ${randomUUID().slice(0, 6)}` });
  const acct = await env.admin.accounts.create({ customerId: customer.id, categoryId: env.categoryId });
  await env.admin.accounts.activate({ accountId: acct.id, reason: "Test", override: true });
  const sp = await env.admin.accounts.servicePoints.create({ accountId: acct.id, address: "Plot 1", schemeId, routeId, connectionStatus: "CONNECTED" });
  const meter = (await env.admin.metering.meters.register({ serial: `M-${randomUUID().slice(0, 8)}`, dialDigits: 5 })).meter;
  await env.admin.metering.installations.install({ meterId: meter.id, servicePointId: sp.id, installedAt: at("2024-12-01"), initialReading: { value: 100 } });
  const ids: Record<string, string> = {};
  for (const [date, value] of readings) ids[date] = (await env.admin.metering.readings.record({ meterId: meter.id, value, readAt: at(date), source: "technician" })).reading.id;
  return { accountId: acct.id, servicePointId: sp.id, meterId: meter.id, readingIds: ids };
}
type Acct = Awaited<ReturnType<typeof account>>;

const drainJobs = async (defs: readonly JobDef[] = jobs) => {
  for (let i = 0; i < 50; i++) if ((await runJobs(env.t.app, defs, { batch: 100 })).claimed === 0) return;
};
/** Bills the period through a cycle on the account's route (the job path). */
async function runCycle(routeId: string, period: string, beforeCalculation?: () => Promise<void>) {
  const cycleId = (await env.admin.billing.cycles.open({ routeId, period })).cycle.id;
  for (const to of ["reading_window", "validation", "estimation"] as const) await env.admin.billing.cycles.advance({ cycleId, to });
  // The snapshot was taken at open; a status change after it is what the job itself must catch.
  await beforeCalculation?.();
  await env.admin.billing.cycles.advance({ cycleId, to: "calculation" });
  await drainJobs();
  return cycleId;
}
const outcomeOf = async (cycleId: string, accountId: string) => (await env.admin.billing.cycles.accounts({ cycleId, limit: 500 })).rows.find((r) => r.accountId === accountId)!;
const count = async (query: ReturnType<typeof sql>) => Number((await env.rows<{ n: string }>(query))[0]!.n);
const readingCount = (servicePointId: string) => count(sql`select count(*)::text n from metering.reading where service_point_id = ${servicePointId}`);
const documents = (accountId: string) => count(sql`select count(*)::text n from billing.document where account_id = ${accountId}`);
const queue = (dedupe: string) => env.rows<{ status: string; type: string; owner_user_id: string | null; raised_at: Date }>(sql`select status, type, owner_user_id, raised_at from kernel.exception where dedupe_key = ${dedupe}`);
const disconnect = (a: Acct, over: Record<string, unknown> = {}) =>
  env.admin.billing.disconnections.disconnect({ id: randomUUID(), accountId: a.accountId, dial: 140, readAt: at("2025-03-10"), reason: "Non-payment", turnOffFeeChargeItemId: feeItem, ...over });

describe("disconnection (B-12)", () => {
  let a: Acct;
  const id = randomUUID();

  it("records the final reading, posts the month in full and the turn-off fee once, then disconnects", async () => {
    a = await account(await newRoute());
    const done = await env.admin.billing.disconnections.disconnect({ id, accountId: a.accountId, dial: 140, readAt: at("2025-03-10"), reason: "Non-payment", turnOffFeeChargeItemId: feeItem });
    expect(done).toMatchObject({ replayed: false, finalBillOutcome: "issued", account: { serviceStatus: "DISCONNECTED", commercialStatus: "ACTIVE" } });
    // 10 units (6 at 82.50, 4 at 96.00) + the 150.00 standing charge + the 500.00 turn-off fee.
    expect(done.finalBill).toMatchObject({ finalBill: true, kind: "invoice", total: 6n * 8250n + 4n * 9600n + 15_000n + 50_000n });
    expect(done.finalBill!.lines.map((l) => l.lineType).sort()).toEqual(["consumption", "fee", "standing"]);
    const finals = await env.rows<{ value: string; purpose: string }>(sql`select value::text, purpose from metering.reading where service_point_id = ${a.servicePointId} and purpose = 'final'`);
    expect(finals).toEqual([{ value: "140", purpose: "final" }]);
  });

  it("repeating the command posts nothing again", async () => {
    const before = { docs: await documents(a.accountId), readings: await readingCount(a.servicePointId) };
    const again = await env.admin.billing.disconnections.disconnect({ id, accountId: a.accountId, dial: 140, readAt: at("2025-03-10"), reason: "Non-payment", turnOffFeeChargeItemId: feeItem });
    expect(again).toMatchObject({ replayed: true, finalBillOutcome: "issued" });
    expect({ docs: await documents(a.accountId), readings: await readingCount(a.servicePointId) }).toEqual(before);
    expect(await count(sql`select count(*)::text n from billing.document where account_id = ${a.accountId} and final_bill`)).toBe(1);
  });

  it("refuses a second disconnection event for the same month: no double final bill, nothing half done", async () => {
    const before = { docs: await documents(a.accountId), readings: await readingCount(a.servicePointId) };
    await expectCode(disconnect(a, { dial: 141 }), "PRECONDITION_FAILED");
    expect({ docs: await documents(a.accountId), readings: await readingCount(a.servicePointId) }).toEqual(before);
  });

  it("needs the final reading for a metered account, and refuses a reading the validation blocks, leaving no trace", async () => {
    const b = await account(await newRoute());
    await expectCode(env.admin.billing.disconnections.disconnect({ id: randomUUID(), accountId: b.accountId, reason: "x" }), "BAD_REQUEST", /final reading/);
    // 90 is below the last actual reading (130): blocked, not rolled over.
    await expectCode(disconnect(b, { dial: 90 }), "PRECONDITION_FAILED", /BELOW_LAST/);
    expect(await documents(b.accountId)).toBe(0);
    expect(await readingCount(b.servicePointId)).toBe(1 + HISTORY.length);
    expect(await env.admin.accounts.get({ id: b.accountId })).toMatchObject({ serviceStatus: "CONNECTED" });
  });

  it("needs billing:run and accounts:change_status", async () => {
    const b = await account(await newRoute());
    await expectCode(env.accountant().billing.disconnections.disconnect({ id: randomUUID(), accountId: b.accountId, dial: 140, reason: "x" }), "FORBIDDEN");
    await expectCode(env.clerk().billing.disconnections.disconnect({ id: randomUUID(), accountId: b.accountId, dial: 140, reason: "x" }), "FORBIDDEN");
  });

  it("works without Metering: the caller gives the dial and history (NF-31)", async () => {
    const plain = await setupBillingEnv();
    try {
      const customer = await plain.admin.accounts.customers.create({ type: "person", name: "Holder" });
      const acct = await plain.admin.accounts.create({ customerId: customer.id, categoryId: plain.categoryId });
      await plain.admin.accounts.activate({ accountId: acct.id, reason: "Test", override: true });
      const current = (await plain.admin.config.list()).find((s) => s.key === "billing.policy");
      await plain.admin.config.set({ key: "billing.policy", value: { ...(current?.value as object), usageInvoiceTypeCode: "water_bill" }, expectedVersion: current?.version ?? 0 });
      const done = await plain.admin.billing.disconnections.disconnect({ id: randomUUID(), accountId: acct.id, dial: 120, readAt: at("2025-03-10"), readings: [{ period: "2025-02", kind: "actual", dial: 110 }], reason: "Request" });
      expect(done).toMatchObject({ finalReadingId: null, finalBillOutcome: "issued", account: { serviceStatus: "DISCONNECTED" } });
    } finally {
      await plain.t.stop();
    }
  });

  describe("reconnection", () => {
    it("restarts from the final reading: the same dial reconnects with no case and no new reading", async () => {
      const readings = await readingCount(a.servicePointId);
      const rid = randomUUID();
      const done = await env.admin.billing.disconnections.reconnect({ id: rid, accountId: a.accountId, dial: 140, reason: "Paid" });
      expect(done).toMatchObject({ outcome: "reconnected", movedBy: 0, finalDial: 140, case: null, account: { serviceStatus: "CONNECTED" } });
      // Disconnected and reconnected in the same month: still one final reading, never two different ones (B-12).
      expect(await readingCount(a.servicePointId)).toBe(readings);
      expect(await env.admin.billing.disconnections.reconnect({ id: rid, accountId: a.accountId, dial: 140, reason: "Paid" })).toMatchObject({ replayed: true });
    });

    it("a moved dial still reconnects but opens an illegal-consumption case and an exception with owner and age", async () => {
      const b = await account(await newRoute());
      await disconnect(b);
      const readings = await readingCount(b.servicePointId);
      const rid = randomUUID();
      const done = await env.admin.billing.disconnections.reconnect({ id: rid, accountId: b.accountId, dial: 155, reason: "Paid" });
      expect(done).toMatchObject({ outcome: "reconnected_suspected_illegal_consumption", movedBy: 15, account: { serviceStatus: "CONNECTED" }, case: { kind: "illegal_consumption", status: "open" } });
      expect(await readingCount(b.servicePointId)).toBe(readings);
      const caseId = done.case!.id;
      expect(caseId).toBe(derivedId(`reconnect-case:${rid}`));
      const item = await queue(`case:${caseId}`);
      expect(item).toMatchObject([{ status: "open", type: "REVENUE_CASE", owner_user_id: env.members.admin.userId }]);
      expect(new Date(item[0]!.raised_at).getTime()).toBeGreaterThan(0);
      // A retry opens no second case.
      await env.admin.billing.disconnections.reconnect({ id: rid, accountId: b.accountId, dial: 155, reason: "Paid" });
      expect(await count(sql`select count(*)::text n from billing.revenue_case where account_id = ${b.accountId} and event = 'opened'`)).toBe(1);
    });

    it("a dial lower than the final reading is a case, never negative consumption", async () => {
      const b = await account(await newRoute());
      await disconnect(b);
      const docs = await documents(b.accountId);
      const done = await env.admin.billing.disconnections.reconnect({ id: randomUUID(), accountId: b.accountId, dial: 120, reason: "Paid" });
      expect(done).toMatchObject({ outcome: "reconnected_suspected_illegal_consumption", movedBy: -20 });
      expect(done.case!.events[0]!.detail).toMatch(/lower than at disconnection/);
      expect(await documents(b.accountId)).toBe(docs);
    });

    it("needs a final bill to restart from", async () => {
      const b = await account(await newRoute());
      await env.admin.accounts.disconnectService({ accountId: b.accountId, reason: "By hand" });
      await expectCode(env.admin.billing.disconnections.reconnect({ id: randomUUID(), accountId: b.accountId, dial: 130, reason: "x" }), "PRECONDITION_FAILED", /no final bill/);
    });
  });
});

describe("bills for blocked statuses (B-09)", () => {
  /** The account is not expected in a cycle opened after the change, and a job that meets the status after the snapshot excludes it. */
  async function check(change: (a: Acct) => Promise<void>, reason: RegExp) {
    const route = await newRoute();
    const a = await account(route);
    const midCycle = await runCycle(route, "2025-04", () => change(a));
    const o = await outcomeOf(midCycle, a.accountId);
    expect(o).toMatchObject({ expected: true, outcome: "excluded", reason: expect.stringMatching(reason) });
    expect(o.documentId ?? null).toBeNull();
    const docsAfterJob = await documents(a.accountId);
    const next = await runCycle(route, "2025-05");
    expect(await outcomeOf(next, a.accountId)).toMatchObject({ expected: false, outcome: null });
    expect(await documents(a.accountId)).toBe(docsAfterJob);
    return { a, docs: docsAfterJob };
  }

  it("DISCONNECTED: no cycle bill after the final bill", async () => {
    const { a, docs } = await check(async (x) => void (await disconnect(x)), /status|blocked|DISCONNECTED/i);
    // Only the final bill exists.
    expect(docs).toBe(1);
    expect(await count(sql`select count(*)::text n from billing.document where account_id = ${a.accountId} and final_bill`)).toBe(1);
  });

  it("DORMANT: no bill at all", async () => {
    const { docs } = await check(async (x) => void (await env.admin.accounts.makeDormant({ accountId: x.accountId, reason: "Empty plot" })), /status|blocked|DORMANT/i);
    expect(docs).toBe(0);
  });

  it("TERMINATED: blocked after the final bill", async () => {
    const { docs } = await check(async (x) => {
      await disconnect(x);
      const owing = (await env.admin.billing.balance({ accountId: x.accountId })).balance;
      const asked = await env.admin.billing.adjustments.request({ accountId: x.accountId, kind: "credit_note", amount: owing, reasonCode: "GOODWILL", note: "Settle" });
      await env.accountant().approvals.approve({ id: asked.approvalId });
      await env.admin.billing.creditNotes.issue({ approvalId: asked.approvalId, accountId: x.accountId, invoiceTypeId: env.invoiceTypeId, lines: [{ description: "Settlement", amount: owing }], note: "Settle" });
      await env.admin.accounts.terminate({ accountId: x.accountId, reason: "Leaving" });
    }, /status|blocked|TERMINATED/i);
    // The final bill and the settling credit note; no usage bill.
    expect(docs).toBe(2);
  });
});

describe("corrections (B-13, B-14)", () => {
  it("a corrected reading of a billed period posts a credit note in the current period, citing the invoice, then nothing more", async () => {
    const route = await newRoute();
    const a = await account(route);
    const cycleId = await runCycle(route, "2025-02");
    const billed = await outcomeOf(cycleId, a.accountId);
    expect(billed).toMatchObject({ outcome: "billed" });
    const original = await env.admin.billing.documents.get({ id: billed.documentId! });
    expect(original.total).toBe(6n * 8250n + 9n * 9600n + 15_000n);

    // The office corrects the reading: 125 instead of 130, so 10 units instead of 15.
    await env.admin.metering.readings.correct({ readingId: a.readingIds["2025-02-27"]!, value: 125, source: "office", reason: "Misread" });
    await drainOutbox(env.t.app, consumers);
    expect(await queue(`correction:${a.accountId}:2025-02`)).toMatchObject([{ status: "open", type: "CORRECTION_NEEDED" }]);

    const preview = await env.admin.billing.corrections.preview({ accountId: a.accountId, period: "2025-02" });
    expect(preview.documents).toMatchObject([{ period: "2025-02", kind: "credit_note", total: -(5n * 9600n), relatedDocumentId: original.id, originalNumber: original.number }]);
    expect(preview.documents[0]!.text).toContain(original.number);
    expect(preview.decision).toMatchObject({ route: "clerk", withinGrace: true, needsEvidence: false });

    const balanceBefore = (await env.admin.billing.balance({ accountId: a.accountId })).balance;
    await expectCode(env.clerk().billing.corrections.post({ id: randomUUID(), accountId: a.accountId, period: "2025-02" }), "FORBIDDEN");
    const key = randomUUID();
    const posted = await env.accountant().billing.corrections.post({ id: key, accountId: a.accountId, period: "2025-02" });
    if (posted.outcome !== "posted") throw new Error("expected a posted correction");
    const doc = posted.documents[0]!;
    expect(doc).toMatchObject({ kind: "credit_note", relatedDocumentId: original.id, total: -(5n * 9600n) });
    expect(doc.issuedOn).not.toBe("2025-02-28");
    expect(doc.note).toContain("after a reading was corrected");
    expect(doc.lines[0]).toMatchObject({ serviceFrom: "2025-02-01", serviceTo: "2025-02-28", amount: -(5n * 9600n) });
    expect(doc.lines[0]!.calculation).toMatchObject({ code: "CORR", working: { dial: 125, previousDial: 115, units: 10, difference: "-48000" } });
    expect((await env.admin.billing.balance({ accountId: a.accountId })).balance).toBe(balanceBefore - 48_000n);
    // The original invoice is untouched.
    expect(await env.admin.billing.documents.get({ id: original.id })).toMatchObject({ total: original.total });
    expect((await queue(`correction:${a.accountId}:2025-02`))[0]!.status).toBe("resolved");

    // Replay and a new attempt both post nothing.
    expect(await env.accountant().billing.corrections.post({ id: key, accountId: a.accountId, period: "2025-02" })).toMatchObject({ outcome: "posted", replayed: true });
    expect(await env.accountant().billing.corrections.post({ id: randomUUID(), accountId: a.accountId, period: "2025-02" })).toMatchObject({ outcome: "nothing" });
    expect((await env.admin.billing.balance({ accountId: a.accountId })).balance).toBe(balanceBefore - 48_000n);
  });

  describe("after the grace window", () => {
    let d: Acct;
    let invoiceId: string;
    beforeAll(async () => {
      d = await account(await newRoute());
      // An old invoice: issued and due in March 2025 (set directly as the owner role; the app role cannot touch documents), so the grace window has ended.
      const issued = await env.admin.billing.invoices.issueUsage({
        idempotencyKey: `manual-${randomUUID()}`,
        accountId: d.accountId,
        categoryId: env.categoryId,
        invoiceTypeId: env.invoiceTypeId,
        servicePointId: d.servicePointId,
        period: "2025-02",
        reading: { dial: 130 },
        readings: [{ period: "2025-01", kind: "actual", dial: 115, units: 10, months: 1 }],
      });
      if (issued.outcome !== "issued") throw new Error("expected an invoice");
      invoiceId = issued.document.id;
      await env.t.admin.execute(sql`update billing.document set issued_on = '2025-03-01', due_on = '2025-03-15' where id = ${invoiceId}`);
      await env.admin.metering.readings.correct({ readingId: d.readingIds["2025-02-27"]!, value: 125, source: "office", reason: "Misread" });
    });

    it("needs an approved request, not just billing:run", async () => {
      const preview = await env.admin.billing.corrections.preview({ accountId: d.accountId, period: "2025-02" });
      expect(preview.decision).toMatchObject({ route: "approval", withinGrace: false });
      expect(preview.documents[0]).toMatchObject({ relatedDocumentId: invoiceId, kind: "credit_note" });
      await expectCode(env.accountant().billing.corrections.post({ id: randomUUID(), accountId: d.accountId, period: "2025-02" }), "PRECONDITION_FAILED", /approved request/);
    });

    it("a large deviation also needs evidence", async () => {
      const current = (await env.admin.config.list()).find((s) => s.key === "billing.corrections");
      await env.admin.config.set({ key: "billing.corrections", value: { largeDeviation: { percent: 10, amount: "0" } }, expectedVersion: current?.version ?? 0 });
      await expectCode(env.admin.billing.corrections.request({ accountId: d.accountId, period: "2025-02", reasonCode: "READING_CORRECTED", note: "Misread" }), "PRECONDITION_FAILED", /evidence/);
      const withNote = { note: "Photo of the dial taken on site" };
      const asked = await env.admin.billing.corrections.request({ accountId: d.accountId, period: "2025-02", reasonCode: "READING_CORRECTED", note: "Misread", evidence: withNote });
      expect(asked.status).toBe("pending");
      await expectCode(env.accountant().billing.corrections.post({ approvalId: asked.approvalId, accountId: d.accountId, period: "2025-02", evidence: withNote }), "PRECONDITION_FAILED", /pending/);
      // Approved, but no evidence given when posting: still refused.
      await env.accountant().approvals.approve({ id: asked.approvalId });
      await expectCode(env.accountant().billing.corrections.post({ approvalId: asked.approvalId, accountId: d.accountId, period: "2025-02" }), "PRECONDITION_FAILED", /evidence/);
      const posted = await env.accountant().billing.corrections.post({ approvalId: asked.approvalId, accountId: d.accountId, period: "2025-02", evidence: withNote });
      expect(posted).toMatchObject({ outcome: "posted", replayed: false, documents: [{ kind: "credit_note", relatedDocumentId: invoiceId }] });
      // The approval is used once: replaying returns the same documents.
      expect(await env.accountant().billing.corrections.post({ approvalId: asked.approvalId, accountId: d.accountId, period: "2025-02", evidence: withNote })).toMatchObject({ replayed: true });
      expect(await count(sql`select count(*)::text n from billing.document where related_document_id = ${invoiceId}`)).toBe(1);
    });
  });

  it("raises a correction-needed exception for a late reading in a closed period and for a billed reading voided", async () => {
    const route = await newRoute();
    const late = await account(route, [["2024-12-31", 105], ["2025-01-31", 115]]);
    const voided = await account(route);
    await runCycle(route, "2025-02");
    // Fits between the January and December readings, but the period is billed already (M-11).
    const lateReading = await env.admin.metering.readings.record({ meterId: late.meterId, value: 110, readAt: at("2025-01-20"), source: "technician" });
    expect(lateReading.reading.flags).toContain("CLOSED_PERIOD");
    await env.admin.metering.readings.void({ readingId: voided.readingIds["2025-02-27"]!, reason: "Wrong meter" });
    await drainOutbox(env.t.app, consumers);
    expect(await queue(`correction:${late.accountId}:2025-01`)).toMatchObject([{ status: "open", type: "CORRECTION_NEEDED" }]);
    expect(await queue(`correction:${voided.accountId}:2025-02`)).toMatchObject([{ status: "open", type: "CORRECTION_NEEDED" }]);
  });
});

describe("revenue-protection cases (B-19)", () => {
  let a: Acct;
  let caseId: string;
  beforeAll(async () => {
    a = await account(await newRoute());
  });

  it("opens, takes evidence and replays; the log only grows", async () => {
    caseId = randomUUID();
    const opened = await env.admin.billing.cases.open({ id: caseId, kind: "terminated_but_consuming", accountId: a.accountId, servicePointId: a.servicePointId, title: "Water used after termination", detail: "Reported by the meter reader" });
    expect(opened).toMatchObject({ replayed: false, case: { id: caseId, status: "open", kind: "terminated_but_consuming" } });
    expect(await env.admin.billing.cases.open({ id: caseId, kind: "terminated_but_consuming", accountId: a.accountId, title: "x" })).toMatchObject({ replayed: true });
    await expectCode(env.admin.billing.cases.open({ id: caseId, kind: "unbilled_account", accountId: a.accountId, title: "x" }), "CONFLICT");
    const withEvidence = await env.admin.billing.cases.addEvidence({ caseId, detail: "Photo of the bypass", fileId: randomUUID() });
    expect(withEvidence.events.map((e) => e.event)).toEqual(["opened", "evidence"]);
    expect((await env.admin.billing.cases.list({ accountId: a.accountId, status: "open" })).map((c) => c.id)).toContain(caseId);
    expect(await env.clerk().billing.cases.get({ caseId })).toMatchObject({ id: caseId });
    await expectCode(env.clerk().billing.cases.open({ kind: "unbilled_account", accountId: a.accountId, title: "x" }), "FORBIDDEN");
  });

  it("back-billing posts a debit note through approval, within the months limit, and resolves the case", async () => {
    const line = (from: string) => ({ description: "Unbilled consumption", amount: 250_000n, serviceFrom: from, serviceTo: "2026-10-31" });
    const base = { caseId, decision: "back_billed" as const, note: "Confirmed use after termination" };
    await expectCode(env.admin.billing.cases.resolve({ ...base, backBill: { invoiceTypeId: env.invoiceTypeId, lines: [line("2020-01-01")] } }), "PRECONDITION_FAILED", /reach back 12 month/);
    await expectCode(env.admin.billing.cases.resolve({ ...base, backBill: { invoiceTypeId: env.invoiceTypeId, lines: [line("2026-06-01")] } }), "PRECONDITION_FAILED", /approved request/);
    await expectCode(env.admin.billing.cases.resolve({ caseId, decision: "back_billed", note: "x" }), "BAD_REQUEST");

    const asked = await env.admin.billing.cases.requestBackBilling({ caseId, amount: 250_000n, note: "Back-bill four months" });
    await env.accountant().approvals.approve({ id: asked.approvalId });
    await expectCode(env.admin.billing.cases.resolve({ ...base, backBill: { invoiceTypeId: env.invoiceTypeId, lines: [{ ...line("2026-06-01"), amount: 250_001n }], approvalId: asked.approvalId } }), "PRECONDITION_FAILED", /different amount/);
    const before = (await env.admin.billing.balance({ accountId: a.accountId })).balance;
    const resolved = await env.admin.billing.cases.resolve({ ...base, backBill: { invoiceTypeId: env.invoiceTypeId, lines: [line("2026-06-01")], approvalId: asked.approvalId } });
    expect(resolved).toMatchObject({ status: "resolved", decision: "back_billed", documentId: expect.any(String) });
    expect((await env.admin.billing.balance({ accountId: a.accountId })).balance).toBe(before + 250_000n);
    expect(await env.admin.billing.documents.get({ id: resolved.documentId! })).toMatchObject({ kind: "debit_note", total: 250_000n });
    expect((await queue(`case:${caseId}`))[0]!.status).toBe("resolved");

    await expectCode(env.admin.billing.cases.resolve({ caseId, decision: "no_action", note: "again" }), "PRECONDITION_FAILED", /already resolved/);
    await expectCode(env.admin.billing.cases.addEvidence({ caseId, detail: "late" }), "PRECONDITION_FAILED", /resolved/);
  });

  it("a case can be resolved without money", async () => {
    const id = randomUUID();
    await env.admin.billing.cases.open({ id, kind: "unbilled_account", accountId: a.accountId, title: "No bill for three months" });
    expect(await env.admin.billing.cases.resolve({ caseId: id, decision: "false_positive", note: "Estimate was posted" })).toMatchObject({ status: "resolved", documentId: null });
  });
});
