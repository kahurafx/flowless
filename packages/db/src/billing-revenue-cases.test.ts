import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Transaction } from "./client";
import { revenueCase } from "./schema/billing";
import { withTenant } from "./tenant";
import { startTestDatabase, tenants, type TestDatabase } from "./testing";

const pgError = (pattern: RegExp) => ({ cause: { message: expect.stringMatching(pattern) } });

let t: TestDatabase;
beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(() => t?.stop());

const asA = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app, tenants.a.id, fn);
const org = tenants.a.id;

async function open(tx: Transaction, accountId = randomUUID()) {
  const id = randomUUID();
  await tx.insert(revenueCase).values({ id, caseId: id, organizationId: org, event: "opened", kind: "illegal_consumption", accountId, title: "Dial moved" });
  return { id, accountId };
}
const evidence = (tx: Transaction, c: { id: string; accountId: string }, over: Partial<typeof revenueCase.$inferInsert> = {}) =>
  tx.transaction((s) => s.insert(revenueCase).values({ organizationId: org, caseId: c.id, event: "evidence", kind: "illegal_consumption", accountId: c.accountId, detail: "Photo of the bypass", ...over }));

describe("revenue case log (B-19)", () => {
  it("opens a case, takes evidence and one resolution, then nothing more", async () => {
    await asA(async (tx) => {
      const c = await open(tx);
      await evidence(tx, c);
      await tx.insert(revenueCase).values({ organizationId: org, caseId: c.id, event: "resolved", kind: "illegal_consumption", accountId: c.accountId, detail: "Confirmed", decision: "penalty_applied" });
      await expect(evidence(tx, c)).rejects.toMatchObject(pgError(/resolved/));
      await expect(
        tx.transaction((s) => s.insert(revenueCase).values({ organizationId: org, caseId: c.id, event: "resolved", kind: "illegal_consumption", accountId: c.accountId, detail: "Again", decision: "no_action" })),
      ).rejects.toMatchObject(pgError(/resolved/));
    });
  });

  it("refuses events on an unknown case or that change the kind or account", async () => {
    await asA(async (tx) => {
      const c = await open(tx);
      await expect(evidence(tx, { id: randomUUID(), accountId: c.accountId })).rejects.toMatchObject({});
      await expect(evidence(tx, c, { kind: "back_billing" })).rejects.toMatchObject(pgError(/kind or account/));
      await expect(evidence(tx, c, { accountId: randomUUID() })).rejects.toMatchObject(pgError(/kind or account/));
    });
  });

  it("checks the shape of each event", async () => {
    await asA(async (tx) => {
      const c = await open(tx);
      await expect(evidence(tx, c, { detail: "" })).rejects.toMatchObject(pgError(/evidence_content/));
      await expect(tx.transaction((s) => s.insert(revenueCase).values({ organizationId: org, caseId: c.id, event: "resolved", kind: "illegal_consumption", accountId: c.accountId, detail: "x" }))).rejects.toMatchObject(pgError(/decision_on_resolved/));
      await expect(tx.transaction((s) => s.insert(revenueCase).values({ organizationId: org, caseId: randomUUID(), event: "opened", kind: "unbilled_account", accountId: c.accountId, title: "x" }))).rejects.toMatchObject(pgError(/opened_self/));
    });
  });

  it("is append-only and tenant-isolated", async () => {
    const c = await asA((tx) => open(tx));
    await expect(asA((tx) => tx.execute(sql`update billing.revenue_case set detail = 'x' where id = ${c.id}`))).rejects.toMatchObject({});
    await expect(asA((tx) => tx.execute(sql`delete from billing.revenue_case where id = ${c.id}`))).rejects.toMatchObject({});
    const other = await withTenant(t.app, tenants.b.id, (tx) => tx.select().from(revenueCase));
    expect(other.find((r) => r.id === c.id)).toBeUndefined();
  });
});
