import { auditLog, outboxEvent, withTenant, type Transaction } from "@flowless/db";
import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { procedureEnv, systemEnv } from "./action-env";
import { defineEvent } from "./events";

let t: TestDatabase;
beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(() => t?.stop());

const pinged = defineEvent("test.env_pinged", z.object({ n: z.number() }));

describe("action env builders", () => {
  it("procedureEnv names the signed-in person, defaults the source to api and delegates to the context", async () => {
    const audit = vi.fn(async () => {});
    const publish = vi.fn(async () => ({}));
    const tx = {} as Transaction;
    const ctx = { tx, organizationId: tenants.a.id, session: { user: { id: "user-1" } }, audit, publish };

    const env = procedureEnv(ctx);
    expect(env).toMatchObject({ tx, organizationId: tenants.a.id, actor: { userId: "user-1" }, source: "api" });
    expect(procedureEnv({ ...ctx, source: "mobile" }).source).toBe("mobile");

    await env.audit({ action: "x.y", subjectType: "thing", subjectId: "1" });
    await env.publish(pinged, { n: 1 });
    expect(audit).toHaveBeenCalledWith({ action: "x.y", subjectType: "thing", subjectId: "1" });
    expect(publish).toHaveBeenCalledWith(pinged, { n: 1 });
  });

  it("systemEnv acts as nobody, audits as the system and queues events for the organization", async () => {
    await withTenant(t.app, tenants.a.id, async (tx) => {
      const env = systemEnv(tx, tenants.a.id);
      expect(env).toMatchObject({ organizationId: tenants.a.id, actor: { userId: null }, source: "system" });
      await env.audit({ action: "test.env_system", subjectType: "thing", subjectId: "env-1" });
      await env.publish(pinged, { n: 7 });
      expect(() => env.publish(pinged, { n: "bad" } as never)).toThrow();
    });

    const [entry] = await t.admin
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.organizationId, tenants.a.id), eq(auditLog.action, "test.env_system")));
    expect(entry).toMatchObject({ source: "system", actorUserId: null, actorLabel: "System", subjectId: "env-1" });
    const events = await t.admin
      .select()
      .from(outboxEvent)
      .where(and(eq(outboxEvent.organizationId, tenants.a.id), eq(outboxEvent.type, pinged.type)));
    expect(events.map((e) => e.payload)).toEqual([{ n: 7 }]);
  });
});
