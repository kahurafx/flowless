import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { structureAttachmentRule } from "@flowless/db/schema/gis";
import { personalBranch, STRUCTURE_ATTACHMENT_RULES, workLevel, type Permission } from "@flowless/shared-types";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, it } from "vitest";
import { setEntitlements } from "../../../kernel/entitlement-store";
import { drainOutbox } from "../../../kernel/events";
import { WorkRegistry } from "../../../kernel/work";
import { consumers, fileSubjects, work } from "../../../wiring";
import { GIS_WORK_KINDS, register } from "..";
import { decidePersonalBranchWrite } from "../link/branch-guard";
import { expectCode, setupTestEnv, type TestEnv } from "./test-support";

// Majimap's work-orders/test/kinds.test.ts (GIS kinds), plus the Flowless wiring: the
// licence levels, the attachment-rule seeding, the personal-branch guard and the file subject.

describe("GIS work kinds", () => {
  it("register cleanly, and every one is available to a GIS-only organization (level basic)", () => {
    const registry = new WorkRegistry();
    register(registry);
    const offered = registry
      .availableKinds(["gis"], "basic")
      .map((k) => k.key)
      .sort();
    assert.deepEqual(offered, GIS_WORK_KINDS.map((k) => k.key).sort());
    assert.equal(GIS_WORK_KINDS.length, 11);
    assert.deepEqual(registry.availableKinds(["work-orders"], "full"), [], "Work Orders alone has no GIS kinds");
  });

  it("give every kind a label, and let technicians raise only what they find in the field", () => {
    for (const def of GIS_WORK_KINDS) assert.ok(def.label.length > 0, def.key);
    assert.deepEqual(
      GIS_WORK_KINDS.filter((k) => k.selfRaise)
        .map((k) => k.key)
        .sort(),
      ["asset_capture", "asset_update", "connection_capture", "inspection", "leak"],
    );
  });

  it("send anything that creates or edits network data through review", () => {
    for (const def of GIS_WORK_KINDS.filter((k) => k.gis === "creates" || k.gis === "edits")) assert.equal(def.review, "required", def.key);
  });

  it("are wired into the app's registry with the GIS ports", async () => {
    assert.equal(work.getWorkKind("valve_exercise")?.module, "gis");
    assert.equal(work.getWorkKind("customer_capture"), undefined, "renamed connection_capture");
    assert.throws(() => register(work), /already registered/);
    assert.ok(fileSubjects.some((s) => s.kind === "gis_asset"));
  });
});

describe("the personal-branch guard", () => {
  const perms = (...p: Permission[]) => new Set<Permission>(p);
  it("lets the owner and gis:post holders write, nobody else", () => {
    const owner = randomUUID();
    assert.deepEqual(decidePersonalBranchWrite(personalBranch(owner), { userId: owner, permissions: perms("gis:edit") }), { allowed: true });
    assert.deepEqual(decidePersonalBranchWrite(personalBranch(owner).toUpperCase(), { userId: owner, permissions: perms("gis:edit") }), { allowed: true });
    assert.equal(decidePersonalBranchWrite(personalBranch(owner), { userId: randomUUID(), permissions: perms("gis:edit") }).allowed, false);
    assert.equal(decidePersonalBranchWrite(personalBranch(owner), { userId: randomUUID(), permissions: perms("gis:edit", "gis:post") }).allowed, true);
  });
});

describe("licensing and setup", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setupTestEnv();
  });
  afterAll(() => env?.close());

  it("gives a GIS-only organization the GIS kinds at level basic, and nothing of Work Orders' own", async () => {
    assert.equal(workLevel(["gis"]), "basic");
    const kinds = (await env.gisOnly().workOrders.kinds()).map((k) => k.key).sort();
    assert.deepEqual(kinds, GIS_WORK_KINDS.map((k) => k.key).sort());
    await expectCode(env.gisOnly().workOrders.crews.list(), "NOT_FOUND");
    // The whole GIS workflow runs at level basic.
    const job = await env.gisOnly().workOrders.create({ title: "Capture", kind: "asset_capture", location: { latitude: -1.3, longitude: 36.8 } });
    const { branch } = await env.gisOnly().workOrders.changeSet({ workOrderId: job.id });
    const valve = await env.gisOnly().gis.nodes.create({ type: "valve", name: "Basic", location: { lat: -1.3, lng: 36.8 }, isOpen: true, branch });
    assert.equal(valve.branch, branch);
  });

  it("answers NOT_FOUND for every GIS procedure while GIS is unlicensed, and Work Orders keeps working", async () => {
    await expectCode(env.bare().gis.nodes.list(), "NOT_FOUND");
    await expectCode(env.bare().gis.reconcile.branches(), "NOT_FOUND");
    const workOnly = randomUUID();
    await env.t.admin.execute(sql`insert into auth.organization (id, name, slug, created_at) values (${workOnly}, 'Work only', ${`w-${workOnly}`}, now())`);
    await setEntitlements(env.t.app, workOnly, ["work-orders"]);
    const { addMember } = await import("../../../test-support");
    const owner = env.as(await addMember(env.t, workOnly, "owner"));
    await expectCode(owner.gis.nodes.list(), "NOT_FOUND");
    const kinds = (await owner.workOrders.kinds()).map((k) => k.key);
    assert.ok(!kinds.some((k) => GIS_WORK_KINDS.some((g) => g.key === k)), "no GIS kinds without GIS");
    await expectCode(owner.workOrders.create({ title: "Leak", kind: "leak" }), "BAD_REQUEST");
  });

  it("seeds an organization's attachment rules when GIS is licensed, once", async () => {
    const fresh = randomUUID();
    await env.t.admin.execute(sql`insert into auth.organization (id, name, slug, created_at) values (${fresh}, 'Fresh', ${`f-${fresh}`}, now())`);
    const rules = () => env.db.select().from(structureAttachmentRule).where(eq(structureAttachmentRule.organizationId, fresh));
    await setEntitlements(env.t.app, fresh, ["accounts"]);
    await drainOutbox(env.t.app, consumers);
    assert.equal((await rules()).length, 0, "not licensed for GIS: nothing seeded");

    await setEntitlements(env.t.app, fresh, ["accounts", "gis"]);
    await drainOutbox(env.t.app, consumers);
    const expected = Object.values(STRUCTURE_ATTACHMENT_RULES).flat().length;
    assert.equal((await rules()).length, expected);

    // An organization's own rules survive a later licence change.
    await env.db.delete(structureAttachmentRule).where(eq(structureAttachmentRule.organizationId, fresh));
    await env.db.insert(structureAttachmentRule).values({ organizationId: fresh, nodeType: "valve", structureType: "kiosk" });
    await setEntitlements(env.t.app, fresh, ["gis"]);
    await drainOutbox(env.t.app, consumers);
    assert.deepEqual((await rules()).map((r) => `${r.nodeType}:${r.structureType}`), ["valve:kiosk"]);
  });

  it("seeds them on first use too, if the licence event never arrived", async () => {
    const late = randomUUID();
    await env.t.admin.execute(sql`insert into auth.organization (id, name, slug, created_at) values (${late}, 'Late', ${`l-${late}`}, now())`);
    await setEntitlements(env.t.app, late, ["gis"]);
    // The outbox is not drained: the first write seeds.
    const { addMember } = await import("../../../test-support");
    const owner = env.as(await addMember(env.t, late, "owner"));
    const vault = await owner.gis.structures.create({ type: "vault", name: "Vault", location: { lat: 0, lng: 0 } });
    const valve = await owner.gis.nodes.create({ type: "valve", name: "Housed", location: { lat: 0, lng: 0 }, isOpen: true, structureId: vault.id });
    assert.equal(valve.structureId, vault.id);
  });

  it("lets gis:configure change the rules, audited, and the trigger follows them", async () => {
    await expectCode(env.tech().gis.attachmentRules.set({ nodeType: "hydrant", structureTypes: ["kiosk"] }), "FORBIDDEN");
    const before = await env.admin().gis.attachmentRules.list();
    assert.deepEqual(before.hydrant, []);
    const after = await env.admin().gis.attachmentRules.set({ nodeType: "hydrant", structureTypes: ["kiosk", "kiosk"] });
    assert.deepEqual(after.hydrant, ["kiosk"]);
    const kiosk = await env.admin().gis.structures.create({ type: "kiosk", name: "Kiosk", location: { lat: -1.3, lng: 36.8 } });
    const hydrant = await env.admin().gis.nodes.create({ type: "hydrant", name: "Now allowed", location: { lat: -1.3, lng: 36.8 }, structureId: kiosk.id });
    assert.equal(hydrant.structureId, kiosk.id);
    const audit = await env.db.execute(sql`select action from kernel.audit_log where action = 'gis.attachment_rules.set'`);
    assert.equal(audit.length, 1);
  });

  it("keeps photos on GIS assets to members who read GIS, adds for gis:edit, and only for this organization's assets", async () => {
    const node = await env.admin().gis.nodes.create({ type: "junction", name: "Photographed", location: { lat: -1.3, lng: 36.8 } });
    const photo = await env.photo(env.members.tech, node.id);
    assert.equal(photo.subjectKind, "gis_asset");
    assert.equal((await env.viewer().files.list({ subjectKind: "gis_asset", subjectId: node.id })).length, 1);
    await expectCode(
      env.viewer().files.announce({ id: randomUUID(), subjectKind: "gis_asset", subjectId: node.id, fileName: "x.jpg", mimeType: "image/jpeg", sizeBytes: 10 }),
      "FORBIDDEN",
    );
    await expectCode(env.outsider().files.list({ subjectKind: "gis_asset", subjectId: node.id }), "NOT_FOUND");
    await expectCode(env.bare().files.list({ subjectKind: "gis_asset", subjectId: node.id }), "NOT_FOUND");
  });
});
