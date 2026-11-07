import { auditLog, outboxEvent } from "@flowless/db";
import { startTestDatabase, type TestDatabase } from "@flowless/db/testing";
import { and, asc, eq } from "drizzle-orm";
import { PERMISSION_STATEMENTS, ORGANIZATION_CODE_HEADER, qualifiedUsername } from "@flowless/shared-types";
import { defaultStatements } from "better-auth/plugins/organization/access";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Auth } from "./auth";
import { connectAuth, type AuthConnection } from "./connect";

let t: TestDatabase;
let auth: Auth;
let close: () => Promise<void>;
let getCaller: AuthConnection["getCaller"];

beforeAll(async () => {
  t = await startTestDatabase();
  // The runtime auth role: reaches only the `auth` schema.
  ({ auth, close, getCaller } = connectAuth(t.urlFor("flowless_auth_api")));
});
afterAll(async () => {
  await close?.();
  await t?.stop();
});

const password = "correct horse battery";
const codeHeader = (code: string) => new Headers({ [ORGANIZATION_CODE_HEADER]: code });

/** Onboards an organization the way Flowless does: server-side, for a given owner. */
async function onboard(code: string) {
  const { user: owner } = await auth.api.signUpEmail({
    body: { email: `owner@${code}.test`, password, name: `Owner ${code}` },
  });
  const org = await auth.api.createOrganization({ body: { name: `Water ${code}`, slug: code, userId: owner.id } });
  return { owner, org: org! };
}

/** Adds a staff member who signs in with a username local to the organization. */
async function addStaff(code: string, organizationId: string, local: string, role = "member") {
  const { user } = await auth.api.signUpEmail({
    body: { email: `${local}@${code}.staff.invalid`, password, name: local, username: qualifiedUsername(code, local) },
  });
  await auth.api.addMember({ body: { userId: user.id, organizationId, role: role as "member" } });
  return user;
}

const signInEmail = (code: string, email: string, pw = password) =>
  auth.api.signInEmail({ body: { email, password: pw }, headers: codeHeader(code), returnHeaders: true });

const signInUsername = (code: string, local: string, pw = password) =>
  auth.api.signInUsername({
    body: { username: qualifiedUsername(code, local), password: pw },
    headers: codeHeader(code),
    returnHeaders: true,
  });

/** Cookie header from a sign-in response, for follow-up calls. */
const cookieFrom = (headers: Headers) =>
  new Headers({ cookie: headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });

// Requirements §1: one organization per user, sign-in by organization code. K-03, NF-05.
describe("sign-in by organization code", () => {
  it("an owner signs in with email and lands in their organization", async () => {
    const { org } = await onboard("alpha");
    const { headers } = await signInEmail("alpha", "owner@alpha.test");
    const session = await auth.api.getSession({ headers: cookieFrom(headers) });
    expect(session?.session.activeOrganizationId).toBe(org.id);
  });

  it("staff sign in with a username local to their organization", async () => {
    const { org } = await onboard("bravo");
    await addStaff("bravo", org.id, "baraka");
    const { headers } = await signInUsername("bravo", "Baraka");
    const session = await auth.api.getSession({ headers: cookieFrom(headers) });
    expect(session?.session.activeOrganizationId).toBe(org.id);
  });

  it("two organizations can each have the same local username", async () => {
    const charlie = await onboard("charlie");
    const delta = await onboard("delta");
    await addStaff("charlie", charlie.org.id, "chebet");
    await addStaff("delta", delta.org.id, "chebet");
    await expect(signInUsername("delta", "chebet")).resolves.toBeTruthy();
  });

  it("requires an organization code", async () => {
    await expect(
      auth.api.signInEmail({ body: { email: "owner@alpha.test", password } }),
    ).rejects.toMatchObject({ status: "BAD_REQUEST" });
  });

  it("rejects credentials under another organization's code, without saying why", async () => {
    await onboard("echo");
    const { org: foxtrot } = await onboard("foxtrot");
    await addStaff("foxtrot", foxtrot.id, "otieno");

    await expect(signInEmail("foxtrot", "owner@echo.test")).rejects.toMatchObject({
      status: "UNAUTHORIZED",
      body: { message: "Organization code, username or password is incorrect" },
    });
    await expect(signInUsername("echo", "otieno")).rejects.toMatchObject({ status: "UNAUTHORIZED" });
  });

  it("only owners and admins sign in with email", async () => {
    const { org } = await onboard("golf");
    await addStaff("golf", org.id, "clerk");
    await addStaff("golf", org.id, "boss", "admin");
    await expect(signInEmail("golf", "clerk@golf.staff.invalid")).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    await expect(signInEmail("golf", "boss@golf.staff.invalid")).resolves.toBeTruthy();
  });

  it("rejects a wrong password", async () => {
    await expect(signInEmail("alpha", "owner@alpha.test", "wrong password!")).rejects.toMatchObject({
      status: "UNAUTHORIZED",
    });
  });
});

describe("one organization per user", () => {
  it("refuses a second membership", async () => {
    const hotel = await onboard("hotel");
    const india = await onboard("india");
    await expect(
      auth.api.addMember({ body: { userId: hotel.owner.id, organizationId: india.org.id, role: "member" } }),
    ).rejects.toMatchObject({ body: { message: "A user belongs to exactly one organization" } });
  });

  it("is also enforced by the database", async () => {
    const juliet = await onboard("juliet");
    const kilo = await onboard("kilo");
    await expect(
      t.admin.execute(
        `insert into auth.member (id, organization_id, user_id, role, created_at)
         values (gen_random_uuid(), '${kilo.org.id}', '${juliet.owner.id}', 'member', now())`,
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/member_user_id_unique/) } });
  });

  it("does not let signed-in users create organizations", async () => {
    await onboard("lima");
    const { headers } = await signInEmail("lima", "owner@lima.test");
    await expect(
      auth.api.createOrganization({ headers: cookieFrom(headers), body: { name: "Side project", slug: "sideproject" } }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("has no endpoint to switch the active organization", async () => {
    await onboard("mike");
    const { headers } = await signInEmail("mike", "owner@mike.test");
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/organization/set-active", {
        method: "POST",
        headers: { cookie: cookieFrom(headers).get("cookie")!, origin: "http://localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ organizationId: null }),
      }),
    );
    expect(response.status).toBe(404);

    // Control: the same handler and cookie reach an endpoint that does exist.
    const control = await auth.handler(
      new Request("http://localhost:3000/api/auth/get-session", { headers: { cookie: cookieFrom(headers).get("cookie")! } }),
    );
    expect(control.status).toBe(200);
  });
});

// K-03: Flowless default roles are registered with Better Auth.
describe("default roles", () => {
  it("Flowless resources never reuse a Better Auth statement name", () => {
    for (const resource of Object.keys(PERMISSION_STATEMENTS)) expect(Object.keys(defaultStatements)).not.toContain(resource);
  });

  it("accepts Flowless roles and leaves member management to owners and admins", async () => {
    const { org } = await onboard("november");
    await addStaff("november", org.id, "clerk", "clerk");
    await expect(addStaff("november", org.id, "ghost", "janitor")).rejects.toMatchObject({ status: "BAD_REQUEST" });

    const { headers } = await signInUsername("november", "clerk");
    await expect(
      auth.api.createInvitation({ headers: cookieFrom(headers), body: { email: "new@november.test", role: "clerk" } }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("getCaller reads the membership fresh, so a role change applies at once", async () => {
    const { org } = await onboard("oscar");
    const staff = await addStaff("oscar", org.id, "teller", "cashier");
    const { headers } = await signInUsername("oscar", "teller");
    const cookie = cookieFrom(headers);
    expect((await getCaller(cookie))?.member).toEqual({ organizationId: org.id, role: "cashier" });

    const owner = cookieFrom((await signInEmail("oscar", "owner@oscar.test")).headers);
    await auth.api.updateMemberRole({ headers: owner, body: { memberId: (await memberId(staff.id))!, role: "accountant" } });
    expect((await getCaller(cookie))?.member).toEqual({ organizationId: org.id, role: "accountant" });
  });
});

async function memberId(userId: string) {
  const rows = await t.admin.execute<{ id: string }>(`select id from auth.member where user_id = '${userId}'`);
  return rows[0]?.id;
}

// K-06: identity events land in the tenant's audit log.
describe("audit", () => {
  const entries = (organizationId: string, action: string) =>
    t.admin
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.organizationId, organizationId), eq(auditLog.action, action)))
      .orderBy(asc(auditLog.chainIndex));

  it("records sign-ins and refused sign-ins, with the source and address", async () => {
    const { org, owner } = await onboard("papa");
    await auth.api.signInEmail({
      body: { email: "owner@papa.test", password },
      headers: new Headers({ [ORGANIZATION_CODE_HEADER]: "papa", "x-flowless-client": "web", "x-forwarded-for": "197.248.1.5, 10.0.0.1" }),
    });
    await expect(signInEmail("papa", "owner@papa.test", "wrong password!")).rejects.toBeTruthy();

    const [signedIn] = await entries(org.id, "auth.sign_in");
    expect(signedIn).toMatchObject({ actorUserId: owner.id, source: "web", ipAddress: "197.248.1.5", after: { method: "sign-in/email" } });
    const [refused] = await entries(org.id, "auth.sign_in_failed");
    expect(refused).toMatchObject({ actorUserId: null, actorLabel: "owner@papa.test", reason: "Wrong password", source: "api" });
  });

  it("records an attempt under another organization's code in that organization", async () => {
    await onboard("quebec");
    const { org: romeo } = await onboard("romeo");
    await expect(signInEmail("romeo", "owner@quebec.test")).rejects.toBeTruthy();
    const [refused] = await entries(romeo.id, "auth.sign_in_failed");
    expect(refused).toMatchObject({ actorLabel: "owner@quebec.test", reason: "Not an administrator of this organization" });
  });

  it("records member changes with who made them and the role before and after", async () => {
    const { org, owner } = await onboard("sierra");
    const staff = await addStaff("sierra", org.id, "kamau", "cashier");
    const added = (await entries(org.id, "member.add")).find((e) => e.subjectId === staff.id);
    expect((await entries(org.id, "organization.create"))[0]).toMatchObject({ after: { code: "sierra", owner: "owner@sierra.test" } });
    expect(added).toMatchObject({ source: "system", actorUserId: null, actorLabel: "Flowless", subjectId: staff.id, after: { role: "cashier" } });

    const ownerCookie = cookieFrom((await signInEmail("sierra", "owner@sierra.test")).headers);
    await auth.api.updateMemberRole({ headers: ownerCookie, body: { memberId: (await memberId(staff.id))!, role: "accountant" } });
    const [changed] = await entries(org.id, "member.change_role");
    expect(changed).toMatchObject({
      actorUserId: owner.id,
      subjectId: staff.id,
      before: { role: "cashier" },
      after: { role: "accountant" },
    });
  });
});

// K-09: organization lifecycle events.
describe("organization lifecycle", () => {
  it("onboarding publishes organization.created, keyed by the organization id", async () => {
    const { org } = await onboard("tango");
    const events = await t.admin.select().from(outboxEvent).where(eq(outboxEvent.organizationId, org.id));
    expect(events).toEqual([
      expect.objectContaining({ id: org.id, type: "organization.created", status: "pending", payload: { name: "Water tango", code: "tango" } }),
    ]);
  });
});
