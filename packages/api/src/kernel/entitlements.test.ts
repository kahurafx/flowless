import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, callerFor, sessionOf, type Member } from "../test-support";
import { createCallerFactory, moduleProcedure, router } from "../trpc";
import { setEntitlements } from "./entitlement-store";

let t: TestDatabase;
let clerkA: Member;
let clerkB: Member;
beforeAll(async () => {
  t = await startTestDatabase();
  clerkA = await addMember(t, tenants.a.id, "clerk");
  clerkB = await addMember(t, tenants.b.id, "clerk");
});
afterAll(() => t?.stop());

/** A stand-in module router, built the way every module router is. */
const accountsLike = router({
  list: moduleProcedure("accounts").query(() => "accounts"),
  open: moduleProcedure("accounts", "accounts:create").mutation(() => "opened"),
  approve: moduleProcedure("billing", "billing:approve").mutation(() => "approved"),
});
const moduleCaller = (m: Member) => createCallerFactory(accountsLike)({ db: t.app, session: sessionOf(m) });

// K-04 entitlements, NF-03 server-side enforcement.
describe("entitlements", () => {
  it("an organization starts with no modules and gets what Flowless licenses", async () => {
    await setEntitlements(t.app, tenants.a.id, []);
    expect(await callerFor(t, clerkA).entitlements.list()).toEqual([]);
    const set = await setEntitlements(t.app, tenants.a.id, ["tariffs", "accounts", "gis"]);
    expect(set).toEqual(["accounts", "tariffs", "gis"]); // catalogue order
    expect(await callerFor(t, clerkA).entitlements.list()).toEqual(["accounts", "tariffs", "gis"]);
  });

  it("licences never cross tenants (NF-01)", async () => {
    await setEntitlements(t.app, tenants.a.id, ["accounts", "work-orders"]);
    await setEntitlements(t.app, tenants.b.id, ["gis"]);
    expect(await callerFor(t, clerkA).entitlements.list()).toEqual(["accounts", "work-orders"]);
    expect(await callerFor(t, clerkB).entitlements.list()).toEqual(["gis"]);
  });

  it("an unlicensed module answers NOT_FOUND, as if it were not mounted", async () => {
    await setEntitlements(t.app, tenants.a.id, ["accounts"]);
    expect(await moduleCaller(clerkA).list()).toBe("accounts");
    await setEntitlements(t.app, tenants.a.id, []);
    await expect(moduleCaller(clerkA).list()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("checks the licence before permissions, then requires the permissions", async () => {
    await setEntitlements(t.app, tenants.a.id, ["accounts"]);
    expect(await moduleCaller(clerkA).open()).toBe("opened");
    // Billing is unlicensed: NOT_FOUND even though the clerk also lacks billing:approve.
    await expect(moduleCaller(clerkA).approve()).rejects.toMatchObject({ code: "NOT_FOUND" });

    await setEntitlements(t.app, tenants.a.id, ["accounts", "tariffs", "billing"]);
    await expect(moduleCaller(clerkA).approve()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects unknown modules and modules without their dependencies", async () => {
    await expect(setEntitlements(t.app, tenants.a.id, ["accounts", "teleport"])).rejects.toThrow(/Unknown module: teleport/);
    await expect(setEntitlements(t.app, tenants.a.id, ["billing", "accounts"])).rejects.toThrow(/billing needs tariffs/);
  });
});
