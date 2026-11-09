import { outboxEvent } from "@flowless/db";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isValidAccountNumber, numberingFormatSchema, parseAccountNumber } from "../numbering";
import { numberingSetting } from "../settings";
import { expectCode, setupAccountsEnv, type AccountsEnv } from "./test-support";

let env: AccountsEnv;
beforeAll(async () => {
  env = await setupAccountsEnv();
});
afterAll(() => env?.t.stop());

const defaultFormat = numberingFormatSchema.parse({});
const open = async (caller = env.clerk(), input: { parentAccountId?: string; numbering?: "suffix" | "own"; categoryId?: string } = {}) =>
  caller.accounts.create({ customerId: (await env.person(caller, `Customer ${randomUUID().slice(0, 6)}`)).id, ...input });

/** Sets the numbering format of tenant A, from the current version. */
async function setFormat(value: Record<string, unknown>) {
  const current = (await env.admin.config.list()).find((s) => s.key === numberingSetting.key)!;
  await env.admin.config.set({ key: numberingSetting.key, value, expectedVersion: current.version });
}

// C-02: account numbers unique per organization, check digit, configurable format, parent/child.
describe("account numbers (C-02)", () => {
  it("opens an account NEW and DISCONNECTED with a check-digit number from the default format", async () => {
    const a = await open();
    expect(a).toMatchObject({ commercialStatus: "NEW", serviceStatus: "DISCONNECTED", parentAccountId: null, categoryId: null, phone: null });
    expect(a.serviceStatusReason).toBeTruthy();
    expect(parseAccountNumber(a.number, defaultFormat)).toMatchObject({ ok: true, sequence: 1001 });
    const b = await open();
    expect(parseAccountNumber(b.number, defaultFormat)).toMatchObject({ ok: true, sequence: 1002 });
  });

  it("shows the setting with its default and previews the next number without taking it", async () => {
    const setting = (await env.admin.config.list()).find((s) => s.key === numberingSetting.key);
    expect(setting).toMatchObject({ module: "accounts", version: 0 });
    const first = await env.clerk().accounts.nextNumberPreview();
    const again = await env.clerk().accounts.nextNumberPreview();
    expect(again.next).toBe(first.next);
    expect(first.format).toEqual(defaultFormat);
    const taken = await open();
    expect(taken.number).toBe(first.next);
    expect((await env.clerk().accounts.nextNumberPreview()).next).not.toBe(first.next);
  });

  it("gives parallel creates distinct numbers, all valid (a locked counter, never MAX+1)", async () => {
    const customerIds = await Promise.all(Array.from({ length: 24 }, (_, i) => env.person(env.clerk(), `Parallel ${i}`).then((c) => c.id)));
    const results = await Promise.allSettled(customerIds.map((customerId, i) => env.as(i % 2 ? env.members.clerk : env.members.admin).accounts.create({ customerId })));
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const numbers = results.map((r) => (r as PromiseFulfilledResult<{ number: string }>).value.number);
    expect(new Set(numbers).size).toBe(24);
    for (const n of numbers) expect(isValidAccountNumber(n, defaultFormat)).toBe(true);
    const sequences = numbers.map((n) => (parseAccountNumber(n, defaultFormat) as { sequence: number }).sequence).sort((a, b) => a - b);
    // No gaps and no repeats: each create took the next value in turn.
    expect(sequences.at(-1)! - sequences[0]!).toBe(23);
  });

  it("gives a rolled-back create its number back", async () => {
    const before = (await env.clerk().accounts.nextNumberPreview()).next;
    await expectCode(env.clerk().accounts.create({ customerId: randomUUID() }), "NOT_FOUND");
    expect((await env.clerk().accounts.nextNumberPreview()).next).toBe(before);
    expect((await open()).number).toBe(before);
  });

  it("numbers children with letters per parent: 1008, 1008A, 1008B ...", async () => {
    const parent = await open();
    const a = await open(env.clerk(), { parentAccountId: parent.id });
    const b = await open(env.clerk(), { parentAccountId: parent.id, numbering: "suffix" });
    expect([a.number, b.number]).toEqual([`${parent.number}A`, `${parent.number}B`]);
    expect(a).toMatchObject({ parentAccountId: parent.id, suffixIndex: 1 });
    expect(b.suffixIndex).toBe(2);
    expect(parseAccountNumber(b.number, defaultFormat)).toMatchObject({ ok: true, base: parent.number, suffix: "B", suffixIndex: 2 });

    const otherParent = await open();
    expect((await open(env.clerk(), { parentAccountId: otherParent.id })).number).toBe(`${otherParent.number}A`);
    expect((await env.clerk().accounts.nextNumberPreview({ parentAccountId: parent.id })).next).toBe(`${parent.number}C`);

    const read = await env.clerk().accounts.get({ id: parent.id });
    expect(read.children.map((c) => c.number)).toEqual([a.number, b.number]);
    expect((await env.clerk().accounts.get({ number: b.number.toLowerCase() })).parent).toEqual({ id: parent.id, number: parent.number });
    expect((await env.clerk().accounts.list({ parentAccountId: parent.id })).map((x) => x.number)).toEqual([a.number, b.number]);
  });

  it("gives parallel children of one parent distinct letters", async () => {
    const parent = await open();
    const kids = await Promise.all(Array.from({ length: 10 }, (_, i) => env.as(i % 2 ? env.members.clerk : env.members.admin).accounts.create({ customerId: parent.customerId, parentAccountId: parent.id })));
    expect(kids.map((k) => k.suffixIndex).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(kids.map((k) => k.number)).size).toBe(10);
  });

  it("links a child with its own number (1009 under 1008) and refuses letters under a child", async () => {
    const parent = await open();
    const own = await open(env.clerk(), { parentAccountId: parent.id, numbering: "own" });
    expect(own.parentAccountId).toBe(parent.id);
    expect(own.suffixIndex).toBeNull();
    expect(isValidAccountNumber(own.number, defaultFormat)).toBe(true);
    expect(own.number).not.toContain(parent.number + "A");
    // A child's own children: with letters refused, with their own number fine, and by default their own number.
    await expectCode(env.clerk().accounts.create({ customerId: own.customerId, parentAccountId: own.id, numbering: "suffix" }), "BAD_REQUEST");
    const grandchild = await env.clerk().accounts.create({ customerId: own.customerId, parentAccountId: own.id });
    expect(grandchild.suffixIndex).toBeNull();
    expect(grandchild.parentAccountId).toBe(own.id);
    await expectCode(env.clerk().accounts.create({ customerId: own.customerId, numbering: "own" }), "BAD_REQUEST");
    await expectCode(env.clerk().accounts.nextNumberPreview({ parentAccountId: own.id }), "BAD_REQUEST");
  });

  it("follows the organization's format: prefix, separator, mod 11, and keeps issued numbers", async () => {
    const issued = await open();
    await setFormat({ prefix: "KW", width: 5, start: 2000, checkDigit: "mod11", separator: "-" });
    const format = numberingFormatSchema.parse({ prefix: "KW", width: 5, start: 2000, checkDigit: "mod11", separator: "-" });
    const a = await open();
    const b = await open();
    expect(a.number).toMatch(/^KW-\d{5}-\d$/);
    for (const n of [a.number, b.number]) expect(isValidAccountNumber(n, format)).toBe(true);
    const sequence = (n: string) => (parseAccountNumber(n, format) as { sequence: number }).sequence;
    // The counter only moves forward: raising `start` above it jumps there, the old numbers stay.
    expect(sequence(a.number)).toBeGreaterThanOrEqual(2000);
    expect(sequence(b.number)).toBeGreaterThan(sequence(a.number));
    expect((await env.clerk().accounts.get({ id: issued.id })).number).toBe(issued.number);
    expect((await env.clerk().accounts.nextNumberPreview()).next).toMatch(/^KW-/);
    const child = await open(env.clerk(), { parentAccountId: a.id });
    expect(child.number).toBe(`${a.number}A`);
    expect(isValidAccountNumber(child.number, format)).toBe(true);
  });

  it("skips mod 11 sequences that have no check digit", async () => {
    await setFormat({ prefix: "M", width: 4, start: 5000, checkDigit: "mod11" });
    const format = numberingFormatSchema.parse({ prefix: "M", width: 4, start: 5000, checkDigit: "mod11" });
    const made = [];
    for (let i = 0; i < 24; i++) made.push((await open()).number);
    expect(new Set(made).size).toBe(24);
    for (const n of made) expect(isValidAccountNumber(n, format)).toBe(true);
  });

  it("refuses a numbering format that would be ambiguous", async () => {
    const current = (await env.admin.config.list()).find((s) => s.key === numberingSetting.key)!;
    await expect(env.admin.config.set({ key: numberingSetting.key, value: { prefix: "kw" }, expectedVersion: current.version })).rejects.toBeTruthy();
    await expect(env.admin.config.set({ key: numberingSetting.key, value: { checkDigit: "crc" }, expectedVersion: current.version })).rejects.toBeTruthy();
  });
});

describe("accounts (C-02, C-03)", () => {
  it("audits, publishes accounts.account_opened in the same transaction, and keeps the category opaque", async () => {
    const categoryId = randomUUID();
    const customer = await env.person(env.clerk(), "Evented Customer");
    const a = await env.clerk().accounts.create({ customerId: customer.id, categoryId });
    expect(a.categoryId).toBe(categoryId);
    const trail = (await env.audit(a.id)).filter((e) => e.action === "accounts.account_create");
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ subjectType: "account", after: { number: a.number, commercialStatus: "NEW", serviceStatus: "DISCONNECTED", categoryId } });
    const events = (await env.db.select().from(outboxEvent).where(eq(outboxEvent.type, "accounts.account_opened"))).filter((e) => (e.payload as { accountId: string }).accountId === a.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ version: 1, payload: { accountId: a.id, number: a.number, customerId: customer.id, categoryId, parentAccountId: null, openedByUserId: env.users.clerk } });
  });

  it("reads an account by id or number with its customer's usable phone, and finds it by number, name and phone", async () => {
    const customer = await env.person(env.clerk(), "Findable Fatuma", { contacts: [{ channel: "phone", value: "25400000000" }, { channel: "phone", value: "0755 010 203" }] });
    const a = await env.clerk().accounts.create({ customerId: customer.id });
    const byNumber = await env.clerk().accounts.get({ number: a.number });
    expect(byNumber).toMatchObject({ id: a.id, customerName: "Findable Fatuma", phone: "254755010203", servicePoints: [], children: [], parent: null });

    const ids = async (q: string) => (await env.clerk().accounts.search({ q })).map((x) => x.id);
    expect(await ids(a.number)).toEqual([a.id]);
    expect(await ids(a.number.slice(0, -1))).toContain(a.id);
    expect(await ids("fatuma")).toEqual([a.id]);
    expect(await ids("0755 010 203")).toEqual([a.id]);
    expect(await ids("+254755010203")).toEqual([a.id]);
    expect(await ids("755010")).toEqual([a.id]);
    expect(await ids("nobody-by-this-name")).toEqual([]);
    expect((await env.clerk().accounts.search({ q: a.number }))[0]).toMatchObject({ phone: "254755010203", customerName: "Findable Fatuma" });
    expect((await env.clerk().accounts.customers.get({ id: customer.id })).accounts.map((x) => x.id)).toEqual([a.id]);
  });

  it("lists in number order with a cursor and filters by customer and status", async () => {
    const all = await env.clerk().accounts.list({ limit: 200 });
    expect(all.map((a) => a.number)).toEqual([...all.map((a) => a.number)].sort());
    const page1 = await env.clerk().accounts.list({ limit: 3 });
    const page2 = await env.clerk().accounts.list({ limit: 3, after: page1[2]!.number });
    expect([...page1, ...page2].map((a) => a.number)).toEqual(all.slice(0, 6).map((a) => a.number));
    expect(await env.clerk().accounts.list({ commercialStatus: "ACTIVE" })).toEqual([]);
    expect((await env.clerk().accounts.list({ serviceStatus: "DISCONNECTED", limit: 200 })).length).toBe(all.length);
    const one = all[0]!;
    expect((await env.clerk().accounts.list({ customerId: one.customerId })).map((a) => a.id)).toContain(one.id);
  });

  it("refuses an unknown customer or parent, and a numbering mode without a parent", async () => {
    await expectCode(env.clerk().accounts.create({ customerId: randomUUID() }), "NOT_FOUND");
    const c = await env.person(env.clerk(), "Orphan seeker");
    await expectCode(env.clerk().accounts.create({ customerId: c.id, parentAccountId: randomUUID() }), "NOT_FOUND");
    await expectCode(env.clerk().accounts.create({ customerId: c.id, numbering: "suffix" }), "BAD_REQUEST");
    await expectCode(env.clerk().accounts.get({ number: "NO-SUCH" }), "NOT_FOUND");
  });
});
