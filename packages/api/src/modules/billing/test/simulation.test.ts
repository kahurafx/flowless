import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectCode, setupBillingEnv, type BillingEnv } from "./test-support";

let env: BillingEnv;
beforeAll(async () => {
  env = await setupBillingEnv();
});
afterAll(() => env?.t.stop());

const UNIFORM = { type: "uniform" as const, content: { type: "uniform" as const, rate: 10_000n } };

async function bill(account: string, units: number) {
  const r = await env.admin.billing.invoices.issueUsage(env.usage(account, { reading: { dial: 100 + units } }) as never);
  if (r.outcome !== "issued") throw new Error(r.outcome);
}

const count = async () =>
  (await env.rows<{ d: string; e: string; x: string }>(sql`select (select count(*) from billing.document)::text d, (select count(*) from billing.ledger_entry)::text e, (select count(*) from kernel.exception)::text x`))[0]!;

// T-06
describe("billing.simulation.run", () => {
  it("prices billed spans under a draft vs the tariff in force, and writes nothing", async () => {
    const a = env.newAccount();
    const b = env.newAccount();
    await bill(a, 10);
    await bill(b, 50);
    const before = await count();
    const r = await env.admin.billing.simulation.run({ draft: UNIFORM, accountIds: [a, b] });
    // 10 units: 87,900 -> 100,000. 50 units: 6*8250 + 14*9600 + 30*11000 = 513,900 -> 500,000.
    const byId = new Map(r.accounts.map((x) => [x.accountId, x]));
    expect(byId.get(a)).toMatchObject({ current: 87_900n, draft: 100_000n, delta: 12_100n });
    expect(byId.get(b)).toMatchObject({ current: 513_900n, draft: 500_000n, delta: -13_900n });
    expect(r.totals).toMatchObject({ accounts: 2, affected: 2, spans: 2, delta: -1_800n, current: 601_800n, draft: 600_000n });
    expect(r.topMovers.map((m) => m.accountId)).toEqual([b, a]);
    expect(r.truncated).toBe(false);
    expect(await count()).toEqual(before);
  });

  it("selects by category with a cap, and ignores reversed bills", async () => {
    const c = env.newAccount();
    await bill(c, 10);
    const sel = await env.admin.billing.simulation.run({ draft: UNIFORM, categoryId: env.categoryId, cap: 1 });
    expect(sel.truncated).toBe(true);
    expect(sel.accounts).toHaveLength(1);
    const doc = (await env.admin.billing.documents.list({ accountId: c }))[0]!;
    await env.admin.billing.documents.void({ idempotencyKey: env.key("void"), documentId: doc.id, reason: "test" });
    const after = await env.admin.billing.simulation.run({ draft: UNIFORM, accountIds: [c] });
    expect(after.totals.spans).toBe(0);
  });

  it("refuses an invalid draft, no selection, and members without billing or tariff access", async () => {
    const a = env.newAccount();
    await expectCode(env.admin.billing.simulation.run({ draft: { type: "uniform", content: { type: "uniform", rate: -1n } }, accountIds: [a] }), "BAD_REQUEST");
    await expectCode(env.admin.billing.simulation.run({ draft: { type: "uniform", content: { type: "increasing_block", bands: [] } }, accountIds: [a] }), "BAD_REQUEST");
    await expectCode(env.admin.billing.simulation.run({ draft: UNIFORM } as never), "BAD_REQUEST");
    await expectCode(env.cashier().billing.simulation.run({ draft: UNIFORM, accountIds: [a] }), "FORBIDDEN");
    await expectCode(env.bare().billing.simulation.run({ draft: UNIFORM, accountIds: [randomUUID()] }), "NOT_FOUND");
  });
});
