import { auditLog, file, withTenant } from "@flowless/db";
import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, sessionOf, type Member } from "../test-support";
import { createCallerFactory } from "../trpc";
import { defineFileSubject } from "./file-subjects";
import { createFilesRouter } from "./files";
import { createMemoryStorage } from "./storage";

// A record type a module would register: dispute cases, visible unless "hidden-…".
const disputes = defineFileSubject({
  kind: "dispute",
  module: "kernel",
  label: "Dispute",
  limits: { photos: 2, documents: 1 },
  async authorize(ctx, subjectId, mode) {
    if (subjectId.startsWith("hidden")) throw new TRPCError({ code: "NOT_FOUND", message: "Dispute not found" });
    if (mode !== "read" && !ctx.permissions.has("accounts:update")) throw new TRPCError({ code: "FORBIDDEN", message: "Needs accounts:update" });
    return { manage: ctx.permissions.has("settings:manage") };
  },
});
const invoices = defineFileSubject({ kind: "invoice", module: "billing", label: "Invoice", authorize: async () => ({ manage: false }) });

let t: TestDatabase;
let clerk: Member;
let otherClerk: Member;
let owner: Member;
let technician: Member;
const memory = createMemoryStorage();
beforeAll(async () => {
  t = await startTestDatabase();
  clerk = await addMember(t, tenants.a.id, "clerk");
  otherClerk = await addMember(t, tenants.a.id, "clerk");
  owner = await addMember(t, tenants.a.id, "owner");
  technician = await addMember(t, tenants.a.id, "technician");
});
afterAll(() => t?.stop());
beforeEach(() => t.admin.delete(file));

const as = (m: Member) =>
  createCallerFactory(createFilesRouter([disputes, invoices]))({ db: t.app, session: sessionOf(m), storage: memory.storage });
const photo = (subjectId = "D-1", over: Partial<{ id: string; sizeBytes: number; mimeType: "image/jpeg" | "application/pdf" }> = {}) => ({
  id: randomUUID(),
  subjectKind: "dispute",
  subjectId,
  fileName: "meter dial.jpg",
  mimeType: "image/jpeg" as const,
  sizeBytes: 2048,
  ...over,
});

/** Announces, "uploads" the bytes and confirms. */
async function attach(m: Member, input = photo()) {
  const { file: announced, upload } = await as(m).announce(input);
  memory.put(upload!.url.replace("memory://", ""), input.sizeBytes);
  return (await as(m).confirm({ id: announced.id })).file!;
}

// K-08: tenant-scoped file service.
describe("file service", () => {
  it("keeps bytes under a tenant-prefixed key and lists only confirmed files, with GPS", async () => {
    const input = { ...photo(), latitude: -1.2195, longitude: 36.8869, capturedAt: new Date("2026-11-07T09:30:00Z") };
    const { file: announced, upload } = await as(clerk).announce(input);
    expect(upload!.url).toBe(`memory://${tenants.a.id}/dispute/D-1/${input.id}/meter_dial.jpg`);
    expect(upload!.headers).toEqual({});
    expect(await as(clerk).list({ subjectKind: "dispute", subjectId: "D-1" })).toEqual([]);

    await expect(as(clerk).confirm({ id: announced.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    memory.put(upload!.url.replace("memory://", ""), input.sizeBytes);
    await as(clerk).confirm({ id: announced.id });
    const [listed] = await as(technician).list({ subjectKind: "dispute", subjectId: "D-1" });
    expect(listed).toMatchObject({ id: input.id, kind: "photo", status: "uploaded", position: { latitude: -1.2195, longitude: 36.8869 } });
    expect(listed!.url).toMatch(/^memory:\/\//);

    const [entry] = await t.admin
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "files.add"), eq(auditLog.subjectId, "D-1")));
    expect(entry).toMatchObject({ actorUserId: clerk.userId, subjectType: "dispute", after: { file: input.id, name: "meter dial.jpg" } });
  });

  it("treats a repeated announcement as the same file, even in parallel", async () => {
    const input = photo();
    const [a, b] = await Promise.all([as(clerk).announce(input), as(clerk).announce(input)]);
    expect(a.file.id).toBe(b.file.id);
    expect(await t.admin.select().from(file)).toHaveLength(1);
    await expect(as(clerk).announce({ ...input, subjectId: "D-2" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("holds the per-record limits under parallel announcements, and forgets stale ones", async () => {
    const results = await Promise.allSettled([1, 2, 3].map(() => as(clerk).announce(photo("D-3"))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    await expect(as(clerk).announce(photo("D-3"))).rejects.toMatchObject({ message: "At most 2 photos can be attached" });
    await expect(as(clerk).announce(photo("D-3", { mimeType: "application/pdf" }))).resolves.toBeTruthy();

    await t.admin.execute(sql`update kernel.file set announced_at = now() - interval '2 days' where status = 'pending'`);
    await expect(as(clerk).announce(photo("D-3"))).resolves.toBeTruthy();
    await expect(as(clerk).announce(photo("D-1", { sizeBytes: 26 * 1024 * 1024 }))).rejects.toMatchObject({
      message: "Files can be at most 25 MB",
    });
  });

  it("drops a file whose bytes differ from what was announced", async () => {
    const input = photo();
    const { upload } = await as(clerk).announce(input);
    memory.put(upload!.url.replace("memory://", ""), 99);
    expect(await as(clerk).confirm({ id: input.id })).toEqual({ file: null, problem: expect.stringMatching(/Add it again/) });
    expect(await t.admin.select().from(file)).toEqual([]);
  });

  it("lets the record decide who reads and adds; only the uploader or a manager removes", async () => {
    await expect(as(technician).announce(photo())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(clerk).list({ subjectKind: "dispute", subjectId: "hidden-9" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as(clerk).list({ subjectKind: "invoice", subjectId: "INV-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as(clerk).list({ subjectKind: "nothing", subjectId: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const added = await attach(clerk);
    await expect(as(otherClerk).remove({ id: added.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await as(owner).remove({ id: added.id });
    expect(await as(clerk).list({ subjectKind: "dispute", subjectId: "D-1" })).toEqual([]);
    const [removal] = await t.admin.select().from(auditLog).where(eq(auditLog.action, "files.remove"));
    expect(removal).toMatchObject({ actorUserId: owner.userId, before: { file: added.id } });
  });

  it("never shows another tenant's files, even for the same record id (NF-01)", async () => {
    await attach(clerk);
    const clerkB = await addMember(t, tenants.b.id, "clerk");
    expect(await as(clerkB).list({ subjectKind: "dispute", subjectId: "D-1" })).toEqual([]);
    const [mine] = await withTenant(t.app, tenants.a.id, (tx) => tx.select().from(file));
    await expect(as(clerkB).remove({ id: mine!.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as(clerkB).announce(photo("D-1", { id: mine!.id }))).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
