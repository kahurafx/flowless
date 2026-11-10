import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Transaction } from "./client";
import { cycle, cycleAccount, cycleEvent, cycleOutcome } from "./schema/billing";
import { eq } from "drizzle-orm";
import { withTenant } from "./tenant";
import { startTestDatabase, tenants, type TestDatabase } from "./testing";

/** Drizzle wraps driver errors; the Postgres error is the `cause`. */
const pgError = (pattern: RegExp) => ({ cause: { message: expect.stringMatching(pattern) } });

let t: TestDatabase;
beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(() => t?.stop());

const asA = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app, tenants.a.id, fn);
const org = tenants.a.id;

type State = (typeof cycle.$inferSelect)["state"];
async function newCycle(tx: Transaction, period = "2026-10") {
  const id = randomUUID();
  await tx.insert(cycle).values({ id, organizationId: org, period, cycleDate: `${period}-28`, routeId: randomUUID() });
  await tx.insert(cycleEvent).values({ organizationId: org, cycleId: id, seq: 1, fromState: null, toState: "open", kind: "open" });
  return id;
}
async function move(tx: Transaction, id: string, seq: number, from: State, to: State, kind: "advance" | "skip" | "retreat" | "close", reason?: string) {
  await tx.insert(cycleEvent).values({ organizationId: org, cycleId: id, seq, fromState: from, toState: to, kind, reason: reason ?? null });
  await tx.update(cycle).set({ state: to }).where(eq(cycle.id, id));
}

describe("billing cycle schema (B-02, B-04, B-15)", () => {
  it("a cycle must start open and its first event opens it", async () => {
    await expect(asA((tx) => tx.insert(cycle).values({ organizationId: org, period: "2026-09", cycleDate: "2026-09-28", routeId: randomUUID(), state: "review" }))).rejects.toMatchObject(pgError(/starts open/));
    await expect(
      asA(async (tx) => {
        const id = randomUUID();
        await tx.insert(cycle).values({ id, organizationId: org, period: "2026-09", cycleDate: "2026-09-28", routeId: randomUUID() });
        await tx.insert(cycleEvent).values({ organizationId: org, cycleId: id, seq: 1, fromState: null, toState: "validation", kind: "advance" });
      }),
    ).rejects.toMatchObject(pgError(/first event opens/));
  });

  it("state changes only through the next logged event", async () => {
    await asA(async (tx) => {
      const id = await newCycle(tx);
      await expect(tx.transaction((s) => s.update(cycle).set({ state: "review" }).where(eq(cycle.id, id)))).rejects.toMatchObject(pgError(/logged event/));
      await move(tx, id, 2, "open", "reading_window", "advance");
      // skipping needs the skip kind, a reason, and cannot be an advance
      await expect(tx.transaction((s) => s.insert(cycleEvent).values({ organizationId: org, cycleId: id, seq: 3, fromState: "reading_window", toState: "calculation", kind: "advance" }))).rejects.toMatchObject(pgError(/cannot move/));
      await expect(tx.transaction((s) => s.insert(cycleEvent).values({ organizationId: org, cycleId: id, seq: 3, fromState: "reading_window", toState: "calculation", kind: "skip" }))).rejects.toMatchObject(pgError(/reason/));
      await move(tx, id, 3, "reading_window", "calculation", "skip", "no estimates needed");
      await move(tx, id, 4, "calculation", "validation", "retreat", "late readings");
      await expect(tx.transaction((s) => s.insert(cycleEvent).values({ organizationId: org, cycleId: id, seq: 4, fromState: "validation", toState: "estimation", kind: "advance" }))).rejects.toMatchObject({});
      await expect(tx.transaction((s) => s.insert(cycleEvent).values({ organizationId: org, cycleId: id, seq: 5, fromState: "validation", toState: "open", kind: "retreat", reason: "x" }))).rejects.toMatchObject(pgError(/cannot move/));
    });
  });

  it("closes only from completeness and only when every expected account has an outcome, then locks", async () => {
    await asA(async (tx) => {
      const id = await newCycle(tx, "2026-08");
      const a1 = randomUUID();
      const a2 = randomUUID();
      await tx.insert(cycleAccount).values([
        { organizationId: org, cycleId: id, accountId: a1, expected: true, reason: "eligible" },
        { organizationId: org, cycleId: id, accountId: a2, expected: false, reason: "no_meter" },
      ]);
      const steps: State[] = ["reading_window", "validation", "estimation", "calculation", "review", "issue", "deliver", "completeness"];
      let from: State = "open";
      let seq = 2;
      for (const to of steps) {
        await move(tx, id, seq++, from, to, "advance");
        from = to;
      }
      await expect(tx.transaction((s) => s.insert(cycleEvent).values({ organizationId: org, cycleId: id, seq, fromState: "completeness", toState: "closed", kind: "close" }))).rejects.toMatchObject(pgError(/every expected account/));
      await tx.insert(cycleOutcome).values({ organizationId: org, cycleId: id, accountId: a1, outcome: "excluded", reason: "meter being replaced" });
      await move(tx, id, seq, "completeness", "closed", "close");
      await expect(tx.transaction((s) => s.insert(cycleOutcome).values({ organizationId: org, cycleId: id, accountId: a1, outcome: "excluded", reason: "again" }))).rejects.toMatchObject(pgError(/locked/));
      await expect(tx.transaction((s) => s.insert(cycleEvent).values({ organizationId: org, cycleId: id, seq: seq + 1, fromState: "closed", toState: "review", kind: "retreat", reason: "oops" }))).rejects.toMatchObject(pgError(/does not move/));
    });
  });

  it("outcome rows need a reason, an exception link or a document where their kind says, and are insert-only", async () => {
    await asA(async (tx) => {
      const id = await newCycle(tx, "2026-07");
      const a = randomUUID();
      await tx.insert(cycleAccount).values({ organizationId: org, cycleId: id, accountId: a, expected: true, reason: "eligible" });
      const bad = (v: Partial<typeof cycleOutcome.$inferInsert>) => tx.transaction((s) => s.insert(cycleOutcome).values({ organizationId: org, cycleId: id, accountId: a, outcome: "excluded", reason: "r", ...v }));
      await expect(bad({ reason: null })).rejects.toMatchObject(pgError(/cycle_outcome_reason/));
      await expect(bad({ outcome: "exception", reason: "r" })).rejects.toMatchObject(pgError(/exception_link/));
      await expect(bad({ outcome: "billed", reason: null })).rejects.toMatchObject(pgError(/cycle_outcome_document/));
      await expect(tx.transaction((s) => s.update(cycleOutcome).set({ reason: "x" }))).rejects.toMatchObject(pgError(/permission denied/));
    });
  });
});
