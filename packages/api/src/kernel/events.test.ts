import { area, consumerReceipt, outboxEvent, organizationSettings } from "@flowless/db";
import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { addMember, sessionOf, type Member } from "../test-support";
import { createCallerFactory, router, tenantProcedure } from "../trpc";
import { setEntitlements } from "./entitlement-store";
import { defineConsumer, defineEvent, dispatchOutbox, drainOutbox, replayEvents, type Consumer } from "./events";
import { createOrganizationSettings, organizationCreated } from "./organization-events";

let t: TestDatabase;
let clerkA: Member;
let clerkB: Member;
beforeAll(async () => {
  t = await startTestDatabase();
  clerkA = await addMember(t, tenants.a.id, "clerk");
  clerkB = await addMember(t, tenants.b.id, "clerk");
});
afterAll(() => t?.stop());

let n = 0;
const pinged = defineEvent("test.pinged", z.object({ n: z.number() }));

/** A procedure that publishes, then optionally fails (so its transaction rolls back). */
const publisher = router({
  ping: tenantProcedure.input(z.object({ n: z.number(), fail: z.boolean().default(false), id: z.uuid().optional() })).mutation(
    async ({ ctx, input }) => {
      await ctx.publish(pinged, { n: input.n }, { id: input.id });
      if (input.fail) throw new Error("rolled back");
    },
  ),
  bad: tenantProcedure.mutation(({ ctx }) => ctx.publish(pinged, { n: "not a number" } as never)),
});
const publish = (m: Member, n: number, extra: { fail?: boolean; id?: string } = {}) =>
  createCallerFactory(publisher)({ db: t.app, session: sessionOf(m) }).ping({ n, ...extra });

/** Records what it saw; can be told to fail for a while. */
function recorder(name: string, module: Consumer["module"] = "kernel") {
  const seen: { n: number; organizationId: string; replay: boolean }[] = [];
  let failuresLeft = 0;
  const consumer = defineConsumer({
    name,
    module,
    event: pinged,
    async handle({ organizationId, replay }, payload) {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error(`${name} is down`);
      }
      seen.push({ n: payload.n, organizationId, replay });
    },
  });
  return { consumer: consumer as Consumer, seen, failNext: (times: number) => (failuresLeft = times) };
}

const statusOf = async (organizationId: string) =>
  t.admin.select().from(outboxEvent).where(eq(outboxEvent.organizationId, organizationId)).orderBy(outboxEvent.occurredAt);

beforeEach(async () => {
  // Each test starts with an empty outbox; due times are pulled forward explicitly.
  await t.admin.delete(consumerReceipt);
  await t.admin.delete(outboxEvent);
  n += 100;
});

const makeDue = () => t.admin.execute(sql`update kernel.outbox_event set available_at = now() - interval '1 second'`);

// K-09: transactional outbox, stable ids, idempotent consumers, replay.
describe("outbox", () => {
  it("an event exists only if its transaction committed, and a stable id publishes once", async () => {
    await expect(publish(clerkA, n, { fail: true })).rejects.toThrow("rolled back");
    expect(await statusOf(tenants.a.id)).toEqual([]);

    const id = crypto.randomUUID();
    await publish(clerkA, n, { id });
    await publish(clerkA, n + 1, { id });
    expect((await statusOf(tenants.a.id)).map((e) => e.id)).toEqual([id]);
  });

  it("validates the payload when it is published", async () => {
    await expect(createCallerFactory(publisher)({ db: t.app, session: sessionOf(clerkA) }).bad()).rejects.toThrow();
  });

  it("delivers each event once to each consumer, inside the event's tenant", async () => {
    const one = recorder("test.one");
    const two = recorder("test.two");
    await publish(clerkA, n);
    await publish(clerkB, n + 1);

    expect(await drainOutbox(t.app, [one.consumer, two.consumer])).toMatchObject({ claimed: 2, done: 2 });
    expect(one.seen).toEqual([
      { n, organizationId: tenants.a.id, replay: false },
      { n: n + 1, organizationId: tenants.b.id, replay: false },
    ]);
    expect(two.seen).toHaveLength(2);

    // Nothing is due any more, and a forced re-run finds receipts.
    expect((await dispatchOutbox(t.app, [one.consumer])).claimed).toBe(0);
    await t.admin.execute(sql`update kernel.outbox_event set status = 'pending', available_at = now() - interval '1 second'`);
    await dispatchOutbox(t.app, [one.consumer, two.consumer]);
    expect(one.seen).toHaveLength(2);
  });

  it("retries only the consumer that failed, with backoff, until it succeeds", async () => {
    const steady = recorder("test.steady");
    const flaky = recorder("test.flaky");
    flaky.failNext(1);
    await publish(clerkA, n);

    expect(await dispatchOutbox(t.app, [steady.consumer, flaky.consumer])).toMatchObject({ claimed: 1, retrying: 1 });
    const [waiting] = await statusOf(tenants.a.id);
    expect(waiting).toMatchObject({ status: "pending", attempts: 1, lastError: "test.flaky: test.flaky is down" });
    expect(waiting!.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect((await dispatchOutbox(t.app, [steady.consumer, flaky.consumer])).claimed).toBe(0); // backing off

    await makeDue();
    expect(await dispatchOutbox(t.app, [steady.consumer, flaky.consumer])).toMatchObject({ done: 1 });
    expect(steady.seen).toHaveLength(1);
    expect(flaky.seen).toHaveLength(1);
  });

  it("marks an event failed after the last attempt, keeping the error (NF-24)", async () => {
    const broken = recorder("test.broken");
    broken.failNext(99);
    await publish(clerkA, n);
    for (let i = 0; i < 3; i++) {
      await dispatchOutbox(t.app, [broken.consumer], { maxAttempts: 3 });
      await makeDue();
    }
    const [failed] = await statusOf(tenants.a.id);
    expect(failed).toMatchObject({ status: "failed", attempts: 3, lastError: "test.broken: test.broken is down" });
  });

  it("skips consumers of unlicensed modules without a receipt (NF-31)", async () => {
    const billing = recorder("billing.test", "billing");
    await setEntitlements(t.app, tenants.a.id, []);
    await publish(clerkA, n);
    expect(await drainOutbox(t.app, [billing.consumer])).toMatchObject({ done: 1 });
    expect(billing.seen).toEqual([]);
    expect(await t.admin.select().from(consumerReceipt)).toEqual([]);
  });

  it("replays processed events with the replay flag", async () => {
    const projection = recorder("test.projection");
    await publish(clerkA, n);
    await publish(clerkA, n + 1);
    await drainOutbox(t.app, [projection.consumer]);

    expect(await replayEvents(t.app, projection.consumer, { organizationId: tenants.a.id })).toBe(2);
    expect(projection.seen.filter((s) => s.replay).map((s) => s.n)).toEqual([n, n + 1]);
  });

  it("consumers can only touch their event's tenant (NF-01)", async () => {
    const intruder = defineConsumer({
      name: "test.intruder",
      module: "kernel",
      event: pinged,
      async handle({ tx }) {
        await tx.insert(area).values({ organizationId: tenants.b.id, level: "scheme", code: `X${n}`, name: "Not mine" });
      },
    });
    await publish(clerkA, n);
    await drainOutbox(t.app, [intruder as Consumer], { maxAttempts: 1 });
    const [event] = await statusOf(tenants.a.id);
    expect(event).toMatchObject({ status: "failed" });
    expect(event!.lastError).toMatch(/row-level security/);
  });
});

describe("organization lifecycle", () => {
  it("organization.created gives the organization its settings", async () => {
    await t.admin.delete(organizationSettings).where(eq(organizationSettings.organizationId, tenants.b.id));
    await t.admin.insert(outboxEvent).values({
      id: tenants.b.id,
      organizationId: tenants.b.id,
      type: organizationCreated.type,
      payload: { name: "Canary Water B", code: "canaryb", settings: { locale: "sw-KE" } },
    });
    await drainOutbox(t.app, [createOrganizationSettings as Consumer]);
    const [settings] = await t.admin.select().from(organizationSettings).where(eq(organizationSettings.organizationId, tenants.b.id));
    expect(settings).toMatchObject({ currency: "KES", timeZone: "Africa/Nairobi", locale: "sw-KE" });
  });
});
