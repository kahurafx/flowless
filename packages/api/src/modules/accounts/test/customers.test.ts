import { outboxEvent } from "@flowless/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { expectCode, setupAccountsEnv, type AccountsEnv } from "./test-support";

let env: AccountsEnv;
beforeAll(async () => {
  env = await setupAccountsEnv();
});
afterAll(() => env?.t.stop());

// C-01: customer records with contacts; placeholder phones are no phone.
describe("customers and contacts (C-01)", () => {
  it("creates a person with contacts, normalised to 254 format, the first of a channel primary", async () => {
    const c = await env.clerk().accounts.customers.create({
      type: "person",
      name: "  Wanjiru   Kamau ",
      nationalId: "12 345-678",
      language: "sw",
      notes: "Prefers calls after 5pm",
      contacts: [
        { channel: "phone", value: "0712 345 678", kind: "personal" },
        { channel: "phone", value: "+254 722 000 111", kind: "work" },
        { channel: "email", value: "Wanjiru@Example.test", kind: "personal" },
      ],
    });
    expect(c).toMatchObject({ name: "Wanjiru Kamau", nationalId: "12345678", language: "sw", phone: "254712345678", email: "wanjiru@example.test" });
    expect(c.contacts.map((x) => [x.channel, x.normalized, x.isPrimary])).toEqual([
      ["phone", "254712345678", true],
      ["phone", "254722000111", false],
      ["email", "wanjiru@example.test", true],
    ]);
    const again = await env.clerk().accounts.customers.get({ id: c.id });
    expect(again.contacts).toHaveLength(3);
    expect(again.accounts).toEqual([]);
  });

  it("keeps a placeholder phone as typed, flagged, and counts it as no phone", async () => {
    for (const raw of ["25400000000", "0000000000", "+254 777 777 777", "0"]) {
      const c = await env.person(env.clerk(), `Placeholder ${raw}`, { contacts: [{ channel: "phone", value: raw }] });
      expect(c.phone).toBeNull();
      expect(c.contacts).toMatchObject([{ value: raw, normalized: null, isPlaceholder: true, isPrimary: false }]);
    }
    const c = await env.person(env.clerk(), "Placeholder then real", { contacts: [{ channel: "phone", value: "25400000000" }, { channel: "phone", value: "0733 111 222" }] });
    expect(c.phone).toBe("254733111222");
    expect(c.contacts.find((x) => x.normalized)?.isPrimary).toBe(true);
    await expectCode(env.clerk().accounts.contacts.add({ customerId: c.id, channel: "phone", value: "25400000000", isPrimary: true }), "BAD_REQUEST");
  });

  it("refuses a phone or email that is neither real nor a placeholder", async () => {
    await expectCode(env.person(env.clerk(), "Bad phone", { contacts: [{ channel: "phone", value: "call me" }] }), "BAD_REQUEST");
    await expectCode(env.person(env.clerk(), "Short phone", { contacts: [{ channel: "phone", value: "0712 345" }] }), "BAD_REQUEST");
    await expectCode(env.person(env.clerk(), "Bad email", { contacts: [{ channel: "email", value: "not-an-email" }] }), "BAD_REQUEST");
    await expectCode(env.clerk().accounts.customers.create({ type: "organization", name: "Acme", nationalId: "123" }), "BAD_REQUEST");
    await expectCode(env.clerk().accounts.customers.create({ type: "person", name: "Joe", registrationNumber: "PVT-1" }), "BAD_REQUEST");
  });

  it("adds, updates and removes contacts, keeping exactly one primary per channel and auditing each", async () => {
    const c = await env.person(env.clerk(), "Contact juggler");
    const first = await env.clerk().accounts.contacts.add({ customerId: c.id, channel: "phone", value: "0711 000 001" });
    const second = await env.clerk().accounts.contacts.add({ customerId: c.id, channel: "phone", value: "0711 000 002", kind: "home" });
    expect([first.isPrimary, second.isPrimary]).toEqual([true, false]);

    const moved = await env.clerk().accounts.contacts.update({ id: second.id, patch: { isPrimary: true } });
    expect(moved.isPrimary).toBe(true);
    expect((await env.clerk().accounts.customers.get({ id: c.id })).phone).toBe("254711000002");

    // Replacing a number with a placeholder takes it out of use and hands "primary" to a real one.
    await env.clerk().accounts.contacts.update({ id: second.id, patch: { value: "25400000000" } });
    const afterPlaceholder = await env.clerk().accounts.customers.get({ id: c.id });
    expect(afterPlaceholder.phone).toBe("254711000001");
    expect(afterPlaceholder.contacts.find((x) => x.id === second.id)).toMatchObject({ isPlaceholder: true, normalized: null, isPrimary: false });

    await env.clerk().accounts.contacts.remove({ id: first.id });
    expect((await env.clerk().accounts.customers.get({ id: c.id })).phone).toBeNull();
    await expectCode(env.clerk().accounts.contacts.update({ id: first.id, patch: { kind: "work" } }), "NOT_FOUND");

    const actions = (await env.audit(c.id)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["accounts.customer_create", "accounts.contact_add", "accounts.contact_update", "accounts.contact_remove"]));
  });

  it("updating a contact demotes the old primary, refuses a placeholder primary, and audits before and after only when something changed", async () => {
    const c = await env.person(env.clerk(), "Contact audit");
    const first = await env.clerk().accounts.contacts.add({ customerId: c.id, channel: "phone", value: "0711 100 001" });
    const second = await env.clerk().accounts.contacts.add({ customerId: c.id, channel: "phone", value: "0711 100 002" });
    const updates = async () => (await env.audit(c.id)).filter((e) => e.action === "accounts.contact_update");

    await expectCode(env.clerk().accounts.contacts.update({ id: second.id, patch: { value: "25400000000", isPrimary: true } }), "BAD_REQUEST");
    await expectCode(env.clerk().accounts.contacts.update({ id: second.id, patch: { value: "call me" } }), "BAD_REQUEST");
    await expectCode(env.clerk().accounts.contacts.update({ id: second.id, patch: {} }), "BAD_REQUEST");
    expect(await updates()).toHaveLength(0);

    // Nothing changes: the same primary flag, the same kind, the same value.
    await env.clerk().accounts.contacts.update({ id: first.id, patch: { isPrimary: true, kind: "personal" } });
    expect(await updates()).toHaveLength(0);

    const moved = await env.clerk().accounts.contacts.update({ id: second.id, patch: { isPrimary: true, kind: "work" } });
    expect(moved).toMatchObject({ id: second.id, kind: "work", isPrimary: true });
    const customer = await env.clerk().accounts.customers.get({ id: c.id });
    expect(customer.contacts.map((x) => [x.id === first.id ? "first" : "second", x.isPrimary])).toEqual([
      ["first", false],
      ["second", true],
    ]);
    const entries = await updates();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.before).toEqual({ contactId: second.id, value: "0711 100 002", kind: "personal", isPlaceholder: false, isPrimary: false });
    expect(entries[0]!.after).toEqual({ contactId: second.id, value: "0711 100 002", kind: "work", isPlaceholder: false, isPrimary: true });
  });

  it("promotes the next real contact when the primary is removed", async () => {
    const c = await env.person(env.clerk(), "Promoted", { contacts: [{ channel: "email", value: "a@one.test" }, { channel: "email", value: "b@two.test" }] });
    await env.clerk().accounts.contacts.remove({ id: c.contacts[0]!.id });
    const after = await env.clerk().accounts.customers.get({ id: c.id });
    expect(after.contacts.map((x) => [x.normalized, x.isPrimary])).toEqual([["b@two.test", true]]);
  });

  it("updates a customer, audits before and after, and writes nothing when nothing changed", async () => {
    const c = await env.person(env.clerk(), "Update me", { nationalId: "AA1" });
    const updated = await env.clerk().accounts.customers.update({ id: c.id, patch: { name: "Updated  Name", nationalId: "bb 2", notes: "moved" } });
    expect(updated).toMatchObject({ name: "Updated Name", nationalId: "BB2", notes: "moved" });
    const updates = async () => (await env.audit(c.id)).filter((e) => e.action === "accounts.customer_update");
    const before = await updates();
    expect(before).toHaveLength(1);
    expect(before[0]!.before).toMatchObject({ name: "Update me", nationalId: "AA1" });
    expect(before[0]!.after).toMatchObject({ name: "Updated Name", nationalId: "BB2" });
    await env.clerk().accounts.customers.update({ id: c.id, patch: { name: "Updated Name" } });
    expect(await updates()).toHaveLength(1);
    await expectCode(env.clerk().accounts.customers.update({ id: c.id, patch: { registrationNumber: "PVT" } }), "BAD_REQUEST");
    await expectCode(env.clerk().accounts.customers.update({ id: c.id, patch: {} }), "BAD_REQUEST");
  });

  it("publishes accounts.customer_created with the channels that can be reached", async () => {
    const c = await env.person(env.clerk(), "Evented", { contacts: [{ channel: "phone", value: "25400000000" }, { channel: "email", value: "e@vent.test" }] });
    const [event] = await env.db.select().from(outboxEvent).where(and(eq(outboxEvent.type, "accounts.customer_created"), eq(outboxEvent.organizationId, env.orgA)));
    const mine = (await env.db.select().from(outboxEvent).where(eq(outboxEvent.type, "accounts.customer_created"))).filter((e) => (e.payload as { customerId: string }).customerId === c.id);
    expect(event).toBeTruthy();
    expect(mine[0]).toMatchObject({ version: 1, payload: { customerId: c.id, type: "person", reachableBy: ["email"], createdByUserId: env.users.clerk } });
  });

  it("lists in name order with a cursor, filters by type, and searches by name, phone, id and email", async () => {
    const o = await env.clerk().accounts.customers.create({ type: "organization", name: "Zebra Hotel Ltd", registrationNumber: "pvt-77", contacts: [{ channel: "phone", value: "020 2345 678" }] });
    const p = await env.person(env.clerk(), "Zawadi Searchable", { nationalId: "99887766", contacts: [{ channel: "phone", value: "0799 123 456" }, { channel: "email", value: "zawadi@find.test" }] });
    const names = (list: { name: string }[]) => list.map((c) => c.name);
    const all = await env.clerk().accounts.customers.list({ limit: 200 });
    expect(names(all)).toEqual([...names(all)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    const page1 = await env.clerk().accounts.customers.list({ limit: 2 });
    const page2 = await env.clerk().accounts.customers.list({ limit: 2, after: page1[1]!.id });
    expect(names([...page1, ...page2])).toEqual(names(all).slice(0, 4));
    expect(names(await env.clerk().accounts.customers.list({ type: "organization" }))).toEqual(["Zebra Hotel Ltd"]);

    const found = async (q: string) => names(await env.clerk().accounts.customers.search({ q }));
    expect(await found("zawadi")).toEqual(["Zawadi Searchable"]);
    expect(await found("0799 123 456")).toEqual(["Zawadi Searchable"]);
    expect(await found("+254799123456")).toEqual(["Zawadi Searchable"]);
    expect(await found("799123")).toEqual(["Zawadi Searchable"]);
    expect(await found("99887766")).toEqual(["Zawadi Searchable"]);
    expect(await found("PVT-77")).toEqual(["Zebra Hotel Ltd"]);
    expect(await found("zawadi@find")).toEqual(["Zawadi Searchable"]);
    expect(await found("%")).toEqual([]);
    expect(o.id).not.toBe(p.id);
  });
});

// C-01: duplicate detection is a query, not a block.
describe("duplicate customers (C-01)", () => {
  it("finds the same phone across spellings, the same national id and registration number, and never blocks", async () => {
    const a = await env.person(env.clerk(), "Dup One", { nationalId: "DUP-001", contacts: [{ channel: "phone", value: "0788 000 111" }] });
    const b = await env.person(env.clerk(), "Dup Two", { nationalId: "dup 001", contacts: [{ channel: "phone", value: "+254788000111" }] });
    const c = await env.person(env.clerk(), "Dup Three", { contacts: [{ channel: "phone", value: "0788 000 111" }] });
    const org = await env.clerk().accounts.customers.create({ type: "organization", name: "Dup Co", registrationNumber: "REG 55" });
    const org2 = await env.clerk().accounts.customers.create({ type: "organization", name: "Dup Co Again", registrationNumber: "reg-55" });

    const byCustomer = await env.clerk().accounts.customers.duplicates({ customerId: a.id });
    expect(byCustomer.map((m) => [m.customer.name, m.matchedOn])).toEqual([
      ["Dup Three", ["phone"]],
      ["Dup Two", ["national_id", "phone"]],
    ]);
    const typed = await env.clerk().accounts.customers.duplicates({ phone: "788000111", nationalId: "DUP001" });
    expect(typed.map((m) => m.customer.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect((await env.clerk().accounts.customers.duplicates({ registrationNumber: "REG55" })).map((m) => m.customer.id).sort()).toEqual([org.id, org2.id].sort());
    expect(await env.clerk().accounts.customers.duplicates({ phone: "25400000000" })).toEqual([]);
    await expectCode(env.clerk().accounts.customers.duplicates({ phone: "nope" }), "BAD_REQUEST");
    await expectCode(env.clerk().accounts.customers.duplicates({}), "BAD_REQUEST");
  });
});
