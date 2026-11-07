import { area, auditLog, exception, job, withTenant } from "@flowless/db";
import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { addMember, callerFor, sessionOf, type Member } from "../test-support";
import { createCallerFactory, router, tenantProcedure } from "../trpc";
import { setEntitlements } from "./entitlement-store";
import { defineConsumer, defineEvent, drainOutbox, type Consumer } from "./events";
import { raiseException } from "./exception-store";
import { defineJob, runJobs, type JobDef } from "./jobs";

let t: TestDatabase;
let owner: Member;
let clerk: Member;
beforeAll(async () => {
  t = await startTestDatabase();
  owner = await addMember(t, tenants.a.id, "owner");
  clerk = await addMember(t, tenants.a.id, "clerk");
});
afterAll(() => t?.stop());
beforeEach(async () => {
  await t.admin.delete(exception);
  await t.admin.delete(job);
});

const as = (m: Member) => callerFor(t, m);
const makeDue = () => t.admin.execute(sql`update kernel.job set run_at = now() - interval '1 second' where status = 'queued'`);

/** A job that fails `failures` times, then writes a row through its tenant transaction. */
function flakyJob(failures: number, module: JobDef["module"] = "kernel") {
  let left = failures;
  return defineJob({
    type: `test.flaky_${module}`,
    module,
    label: "Nightly test run",
    schema: z.object({ code: z.string() }),
    maxAttempts: 3,
    async run(ctx, payload) {
      if (left-- > 0) throw new Error("provider timed out");
      await ctx.withTenant((tx) => tx.insert(area).values({ organizationId: ctx.organizationId, level: "scheme", code: payload.code, name: "From a job" }));
      return { wrote: payload.code };
    },
  }) as JobDef;
}

const enqueuer = (def: JobDef) =>
  router({
    start: tenantProcedure
      .input(z.object({ code: z.string(), key: z.string().optional(), fail: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        const id = await ctx.enqueue(def, { code: input.code }, { idempotencyKey: input.key });
        if (input.fail) throw new Error("rolled back");
        return id;
      }),
  });
const enqueue = (def: JobDef, m: Member, input: { code: string; key?: string; fail?: boolean }) =>
  createCallerFactory(enqueuer(def))({ db: t.app, session: sessionOf(m) }).start(input);

/** Runs every due job, pulling backoff forward, until none are left. */
async function runAll(defs: JobDef[]) {
  for (let i = 0; i < 10; i++) {
    await makeDue();
    if ((await runJobs(t.app, defs)).claimed === 0) return;
  }
}

// NF-12: heavy work is queued; NF-24: zero silent failures.
describe("jobs", () => {
  it("are queued only if the request commits, once per idempotency key, and run in their tenant", async () => {
    const def = flakyJob(0);
    await expect(enqueue(def, clerk, { code: "J0", fail: true })).rejects.toThrow("rolled back");
    const first = await enqueue(def, clerk, { code: "J1", key: "nightly-2026-11-07" });
    expect(await enqueue(def, clerk, { code: "J1", key: "nightly-2026-11-07" })).toBe(first);

    expect(await runJobs(t.app, [def])).toMatchObject({ claimed: 1, done: 1 });
    const [done] = await t.admin.select().from(job);
    expect(done).toMatchObject({ status: "done", attempts: 1, result: { wrote: "J1" }, createdByUserId: clerk.userId });
    expect(await t.admin.select().from(area).where(eq(area.code, "J1"))).toHaveLength(1);
  });

  it("retry with backoff, then fail into the queue owned by whoever queued them", async () => {
    const def = flakyJob(99);
    const id = await enqueue(def, clerk, { code: "J2" });
    expect(await runJobs(t.app, [def])).toMatchObject({ retrying: 1 });
    const [waiting] = await t.admin.select().from(job);
    expect(waiting!.runAt.getTime()).toBeGreaterThan(Date.now());
    await runAll([def]);

    const [failed] = await t.admin.select().from(job);
    expect(failed).toMatchObject({ status: "failed", attempts: 3, lastError: "provider timed out" });
    const [item] = await as(owner).exceptions.list();
    expect(item).toMatchObject({
      type: "JOB_FAILURE",
      title: "Nightly test run failed",
      subjectKind: "job",
      subjectRef: id,
      ownerUserId: clerk.userId,
      status: "open",
      retryable: true,
    });
    expect(item!.detail).toMatch(/Gave up after 3 attempts\. provider timed out/);
  });

  it("a retry from the queue runs the job again and resolves the exception when it works", async () => {
    let failing = true;
    const def = defineJob({
      type: "test.switchable",
      module: "kernel",
      label: "Switchable",
      schema: z.object({ code: z.string() }),
      maxAttempts: 1,
      async run() {
        if (failing) throw new Error("down");
      },
    }) as JobDef;
    await enqueue(def, clerk, { code: "J3" });
    await runJobs(t.app, [def]);
    const [item] = await as(clerk).exceptions.list();

    failing = false;
    await as(clerk).exceptions.retry({ id: item!.id });
    expect((await as(clerk).exceptions.list())[0]).toMatchObject({ status: "in_progress", ownerUserId: clerk.userId });
    await runJobs(t.app, [def]);
    expect(await as(clerk).exceptions.list()).toEqual([]);
    const [resolved] = await as(clerk).exceptions.list({ view: "resolved" });
    expect(resolved).toMatchObject({ id: item!.id, resolutionNote: "Succeeded on retry" });
  });

  it("skip modules that are not licensed, and fail visibly for unknown job types (NF-31)", async () => {
    await setEntitlements(t.app, tenants.a.id, []);
    const billingJob = flakyJob(0, "billing");
    await enqueue(billingJob, clerk, { code: "J4" });
    expect(await runJobs(t.app, [billingJob])).toMatchObject({ skipped: 1 });

    await enqueue(flakyJob(0), clerk, { code: "J5" });
    expect(await runJobs(t.app, [])).toMatchObject({ failed: 1 });
    expect((await as(owner).exceptions.list())[0]!.detail).toMatch(/No handler is registered/);
  });
});

describe("events", () => {
  it("an event that cannot be delivered becomes an exception; a retry resolves it", async () => {
    const pinged = defineEvent("test.pinged", z.object({}));
    let down = true;
    const consumer = defineConsumer({
      name: "test.down",
      module: "kernel",
      event: pinged,
      async handle() {
        if (down) throw new Error("projection broken");
      },
    }) as Consumer;
    await withTenant(t.app, tenants.a.id, (tx) =>
      tx.execute(sql`insert into kernel.outbox_event (organization_id, type, payload) values (${tenants.a.id}, 'test.pinged', '{}')`),
    );
    await drainOutbox(t.app, [consumer], { maxAttempts: 1 });
    const [item] = await as(owner).exceptions.list();
    expect(item).toMatchObject({ type: "EVENT_FAILURE", title: "Event not delivered: test.pinged", ownerUserId: null, retryable: true });

    down = false;
    await as(owner).exceptions.retry({ id: item!.id });
    await drainOutbox(t.app, [consumer]);
    expect(await as(owner).exceptions.list()).toEqual([]);
  });
});

// X-02: the exception queue.
describe("exception queue", () => {
  const raise = (organizationId: string, input: Partial<Parameters<typeof raiseException>[2]> = {}) =>
    withTenant(t.app, organizationId, (tx) =>
      raiseException(tx, organizationId, {
        type: "UNMATCHED_PAYMENT",
        source: "payments",
        title: "Payment with unknown account",
        subject: { kind: "payment", ref: "SKZ7T1AB9Q" },
        ...input,
      }),
    );

  it("counts repeats of an open problem instead of adding rows; a resolved one starts afresh", async () => {
    const first = await raise(tenants.a.id, { dedupeKey: "payment:SKZ7T1AB9Q", detail: "first" });
    const again = await raise(tenants.a.id, { dedupeKey: "payment:SKZ7T1AB9Q", detail: "second" });
    expect(again.id).toBe(first.id);
    expect((await as(owner).exceptions.list())[0]).toMatchObject({ occurrences: 2, detail: "second" });

    await as(owner).exceptions.resolve({ id: first.id, note: "Allocated to 1008-4" });
    const fresh = await raise(tenants.a.id, { dedupeKey: "payment:SKZ7T1AB9Q" });
    expect(fresh.id).not.toBe(first.id);
    await expect(as(owner).exceptions.reopen({ id: first.id })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("an owner who leaves makes the exception unassigned, never lost", async () => {
    const cashier = await addMember(t, tenants.a.id, "cashier");
    const { id } = await raise(tenants.a.id, { ownerUserId: cashier.userId });
    await t.auth.execute(sql`delete from auth.member where user_id = ${cashier.userId}`);
    expect((await as(owner).exceptions.list()).find((e) => e.id === id)).toMatchObject({ ownerUserId: null });

    const raisedForLeaver = await raise(tenants.a.id, { ownerUserId: cashier.userId, dedupeKey: "left" });
    expect((await as(owner).exceptions.list()).find((e) => e.id === raisedForLeaver.id)).toMatchObject({ ownerUserId: null });
  });

  it("assign, start and resolve are audited; resolving needs a note", async () => {
    const { id } = await raise(tenants.a.id);
    await as(owner).exceptions.assign({ id, ownerUserId: clerk.userId });
    await as(clerk).exceptions.start({ id });
    await expect(as(clerk).exceptions.resolve({ id, note: " " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await as(clerk).exceptions.resolve({ id, note: "Customer confirmed account 1008-4" });

    const trail = await t.admin
      .select({ action: auditLog.action, actor: auditLog.actorUserId, reason: auditLog.reason })
      .from(auditLog)
      .where(and(eq(auditLog.subjectType, "exception"), eq(auditLog.subjectId, id)))
      .orderBy(auditLog.chainIndex);
    expect(trail).toEqual([
      { action: "exceptions.assign", actor: owner.userId, reason: null },
      { action: "exceptions.start", actor: clerk.userId, reason: null },
      { action: "exceptions.resolve", actor: clerk.userId, reason: "Customer confirmed account 1008-4" },
    ]);
  });

  it("needs exceptions:read, applies scope, and never crosses tenants", async () => {
    const technician = await addMember(t, tenants.a.id, "technician");
    await expect(as(technician).exceptions.list()).rejects.toMatchObject({ code: "FORBIDDEN" });

    const scheme = await as(owner).hierarchy.createArea({ level: "scheme", code: "EXQ", name: "Queue scheme" });
    const zone = await as(owner).hierarchy.createArea({ level: "zone", code: "EXQZ", name: "Queue zone", parentId: scheme.id });
    const placed = await raise(tenants.a.id, { areaId: zone.id });
    const orgWide = await raise(tenants.a.id);
    const limited = await addMember(t, tenants.a.id, "clerk");
    await as(owner).access.setScope({ userId: limited.userId, areaIds: [scheme.id], routeIds: [] });

    const seen = (await as(limited).exceptions.list()).map((e) => e.id);
    expect(seen).toContain(placed.id);
    expect(seen).not.toContain(orgWide.id);
    await expect(as(limited).exceptions.resolve({ id: orgWide.id, note: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await raise(tenants.b.id, { title: "B's own" });
    expect((await as(owner).exceptions.list()).some((e) => e.title === "B's own")).toBe(false);
  });
});
