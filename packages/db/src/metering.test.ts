import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Transaction } from "./client";
import { installation, meter, meterEvent, reading, readingStatus } from "./schema";
import { withTenant } from "./tenant";
import { startTestDatabase, tenants, type TestDatabase } from "./testing";

const pgError = (pattern: RegExp) => ({ cause: { message: expect.stringMatching(pattern) } });
const commitError = (pattern: RegExp) => ({ message: expect.stringMatching(pattern) });

let t: TestDatabase;
beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(() => t?.stop());

const asA = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app, tenants.a.id, fn);
const asB = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app, tenants.b.id, fn);
const org = tenants.a.id;

async function newMeter(tx: Transaction, serial = `S-${randomUUID()}`) {
  const [m] = await tx.insert(meter).values({ organizationId: org, serial, dialDigits: 5, status: "in_stock" }).returning();
  return m!;
}

async function newReading(tx: Transaction, m: { id: string }, value = 10) {
  const [inst] = await tx.insert(installation).values({ organizationId: org, meterId: m.id, servicePointId: randomUUID(), installedAt: new Date("2026-01-01") }).returning();
  const id = randomUUID();
  await tx.insert(reading).values({ id, organizationId: org, meterId: m.id, installationId: inst!.id, servicePointId: inst!.servicePointId, value, readAt: new Date("2026-02-01"), source: "office", fingerprint: "f" });
  await tx.insert(readingStatus).values({ organizationId: org, readingId: id, status: "valid", cleared: true, source: "api" });
  return { id, inst: inst! };
}

describe("metering schema", () => {
  it("keeps serials unique per organization, ignoring case", async () => {
    const serial = `Dup-${randomUUID()}`;
    await asA((tx) => newMeter(tx, serial));
    await expect(asA((tx) => newMeter(tx, serial.toLowerCase()))).rejects.toMatchObject(pgError(/meter_serial_unique/));
    await expect(asB((tx) => tx.insert(meter).values({ organizationId: tenants.b.id, serial, dialDigits: 5, status: "procured" }))).resolves.toBeDefined();
  });

  it("refuses a status change without a matching event", async () => {
    const m = await asA((tx) => newMeter(tx));
    await expect(asA((tx) => tx.update(meter).set({ status: "issued" }).where(sql`id = ${m.id}`))).rejects.toMatchObject(pgError(/needs a new meter_event/));
    await asA(async (tx) => {
      const [e] = await tx.insert(meterEvent).values({ organizationId: org, meterId: m.id, kind: "status_change", fromStatus: "in_stock", toStatus: "issued", source: "api", fingerprint: "x" }).returning();
      await tx.update(meter).set({ status: "issued", statusEventId: e!.id }).where(sql`id = ${m.id}`);
    });
    await expect(
      asA(async (tx) => {
        const [e] = await tx.insert(meterEvent).values({ organizationId: org, meterId: m.id, kind: "status_change", fromStatus: "issued", toStatus: "installed", source: "api", fingerprint: "y" }).returning();
        await tx.update(meter).set({ status: "disposed", statusEventId: e!.id }).where(sql`id = ${m.id}`);
      }),
    ).rejects.toMatchObject(pgError(/does not match its event/));
  });

  it("makes readings, statuses and events append-only", async () => {
    const m = await asA((tx) => newMeter(tx));
    const r = await asA((tx) => newReading(tx, m));
    await expect(asA((tx) => tx.update(reading).set({ value: 99 }).where(sql`id = ${r.id}`))).rejects.toMatchObject(pgError(/permission denied/));
    await expect(asA((tx) => tx.execute(sql`delete from metering.reading where id = ${r.id}`))).rejects.toMatchObject(pgError(/permission denied/));
    await expect(asA((tx) => tx.execute(sql`update metering.reading_status set cleared = false`))).rejects.toMatchObject(pgError(/permission denied/));
    await expect(asA((tx) => tx.execute(sql`delete from metering.meter_event`))).rejects.toMatchObject(pgError(/permission denied/));
    await expect(asA((tx) => tx.execute(sql`delete from metering.meter where id = ${m.id}`))).rejects.toMatchObject(pgError(/permission denied/));
  });

  it("requires a status row with every reading", async () => {
    const m = await asA((tx) => newMeter(tx));
    await expect(
      asA(async (tx) => {
        const [inst] = await tx.insert(installation).values({ organizationId: org, meterId: m.id, servicePointId: randomUUID(), installedAt: new Date("2026-01-01") }).returning();
        await tx.insert(reading).values({ organizationId: org, meterId: m.id, installationId: inst!.id, servicePointId: inst!.servicePointId, value: 1, readAt: new Date(), source: "office", fingerprint: "f" });
      }),
    ).rejects.toMatchObject(commitError(/has no status row/));
  });

  it("closes an installation once, and allows one open installation per meter and per service point", async () => {
    const m = await asA((tx) => newMeter(tx));
    const sp = randomUUID();
    const inst = await asA(async (tx) => (await tx.insert(installation).values({ organizationId: org, meterId: m.id, servicePointId: sp, installedAt: new Date("2026-01-01") }).returning())[0]!);
    const other = await asA((tx) => newMeter(tx));
    await expect(asA((tx) => tx.insert(installation).values({ organizationId: org, meterId: other.id, servicePointId: sp, installedAt: new Date() }))).rejects.toMatchObject(pgError(/installation_service_point_open/));
    await expect(asA((tx) => tx.insert(installation).values({ organizationId: org, meterId: m.id, servicePointId: randomUUID(), installedAt: new Date() }))).rejects.toMatchObject(pgError(/installation_meter_open/));
    await expect(asA((tx) => tx.update(installation).set({ removedAt: new Date("2025-01-01") }).where(sql`id = ${inst.id}`))).rejects.toMatchObject(pgError(/installation_span_valid/));
    await asA((tx) => tx.update(installation).set({ removedAt: new Date("2026-03-01") }).where(sql`id = ${inst.id}`));
    await expect(asA((tx) => tx.update(installation).set({ removedAt: new Date("2026-04-01") }).where(sql`id = ${inst.id}`))).rejects.toMatchObject(pgError(/already closed/));
    await expect(asA((tx) => tx.update(installation).set({ servicePointId: randomUUID() }).where(sql`id = ${inst.id}`))).rejects.toMatchObject(pgError(/permission denied/));
  });

  it("isolates tenants", async () => {
    await asA((tx) => newMeter(tx));
    const seen = await asB((tx) => tx.select().from(meter));
    expect(seen.every((m) => m.organizationId === tenants.b.id)).toBe(true);
  });
});
