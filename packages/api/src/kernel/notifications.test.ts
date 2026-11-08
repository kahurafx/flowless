import { exception, notification, outboxEvent, withTenant } from "@flowless/db";
import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, callerFor, type Member } from "../test-support";
import { setEntitlements } from "./entitlement-store";
import { raiseException } from "./exception-store";
import { notify, type Notify } from "./notification-store";

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
  await t.admin.delete(notification);
  await t.admin.delete(outboxEvent);
});

const send = (input: Partial<Notify> & Pick<Notify, "to">, organizationId = tenants.a.id) =>
  withTenant(t.app, organizationId, (tx) => notify(tx, organizationId, { topic: "test.ping", title: "Ping", ...input }));

// K-07: notification service interface.
describe("notifications", () => {
  it("land in the member's own inbox, once per key, and can be marked read", async () => {
    expect(await send({ to: { userId: clerk.userId }, body: "Check the queue", link: "/exceptions", dedupeKey: "k1" })).toEqual({
      sent: ["in_app"],
      skipped: [],
    });
    await send({ to: { userId: clerk.userId }, dedupeKey: "k1" });
    await send({ to: { userId: clerk.userId }, title: "Second" });

    expect(await callerFor(t, owner).notifications.list()).toEqual([]);
    const inbox = await callerFor(t, clerk).notifications.list();
    expect(inbox.map((n) => n.title)).toEqual(["Second", "Ping"]);
    expect(await callerFor(t, clerk).notifications.unreadCount()).toBe(2);

    await callerFor(t, clerk).notifications.markRead({ ids: [inbox[1]!.id] });
    expect(await callerFor(t, clerk).notifications.unreadCount()).toBe(1);
    await callerFor(t, owner).notifications.markRead({});
    expect(await callerFor(t, clerk).notifications.unreadCount()).toBe(1);
    await callerFor(t, clerk).notifications.markRead({});
    expect(await callerFor(t, clerk).notifications.unreadCount()).toBe(0);
  });

  it("skip a recipient who is not a member here, without failing the caller", async () => {
    const elsewhere = await addMember(t, tenants.b.id, "clerk");
    expect(await send({ to: { userId: elsewhere.userId } })).toEqual({ sent: [], skipped: ["in_app"] });
    expect(await send({ to: { userId: randomUUID() } })).toEqual({ sent: [], skipped: ["in_app"] });
  });

  it("hand other channels to Communications only while it is licensed (NF-31)", async () => {
    await setEntitlements(t.app, tenants.a.id, []);
    const message = { to: { phone: "+254700000001" }, channels: ["sms", "in_app"] as const, template: "reading.reminder", data: { due: "2026-11-15" } };
    expect(await send(message)).toEqual({ sent: [], skipped: ["sms", "in_app"] });

    await setEntitlements(t.app, tenants.a.id, ["accounts", "communications"]);
    expect(await send(message)).toEqual({ sent: ["sms"], skipped: ["in_app"] });
    const [event] = await t.admin.select().from(outboxEvent).where(eq(outboxEvent.type, "notification.requested"));
    expect(event!.payload).toEqual({
      channel: "sms",
      to: { phone: "+254700000001" },
      template: "reading.reminder",
      topic: "test.ping",
      data: { due: "2026-11-15" },
      dedupeKey: null,
    });
    expect(await send({ to: { userId: clerk.userId }, channels: ["email"] })).toEqual({ sent: ["email"], skipped: [] });
    expect(await send({ to: { phone: "+254700000001" }, channels: ["email"] })).toEqual({ sent: [], skipped: ["email"] });
  });

  it("tell a member when an exception is assigned to them", async () => {
    await t.admin.delete(exception);
    const { id } = await withTenant(t.app, tenants.a.id, (tx) =>
      raiseException(tx, tenants.a.id, { type: "UNMATCHED_PAYMENT", source: "payments", title: "Payment SKZ7 with unknown account", subject: { kind: "payment", ref: "SKZ7" } }),
    );
    await callerFor(t, owner).exceptions.assign({ id, ownerUserId: clerk.userId });
    await callerFor(t, owner).exceptions.assign({ id, ownerUserId: owner.userId });
    expect(await callerFor(t, clerk).notifications.list()).toEqual([
      expect.objectContaining({ topic: "exceptions.assigned", body: "Payment SKZ7 with unknown account, from owner", link: "/exceptions" }),
    ]);
    expect(await callerFor(t, owner).notifications.list()).toEqual([]);
  });

  it("go when the member leaves", async () => {
    const leaver = await addMember(t, tenants.a.id, "clerk");
    await send({ to: { userId: leaver.userId } });
    await t.auth.execute(sql`delete from auth.member where user_id = ${leaver.userId}`);
    expect(await t.admin.select().from(notification).where(eq(notification.recipientUserId, leaver.userId))).toEqual([]);
  });
});
