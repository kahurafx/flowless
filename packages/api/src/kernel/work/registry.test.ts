import type { Transaction } from "@flowless/db";
import { workLevel, type ModuleKey, type Permission } from "@flowless/shared-types";
import { describe, expect, it } from "vitest";
import type { AssetRef, AssetResolver, BranchAnnotator, BranchGuard, EvidenceResolver } from "./ports";
import { WorkRegistry } from "./registry";
import type { WorkKindDef } from "./work-kinds";

// Ported from Majimap's kernel/test/registry.test.ts. The registry never touches the
// database itself, so a stand-in transaction is enough.
const tx = {} as Transaction;
const on = (...modules: ModuleKey[]) => modules;

const gisAssets: AssetResolver = {
  module: "gis",
  resolve: async (_tx, ids) =>
    new Map(
      ids
        .filter((id) => id.startsWith("g"))
        .map((id): [string, AssetRef] => [id, { id, module: "gis", type: "valve", name: id, location: null, state: "registered", possibleDuplicateOf: null }]),
    ),
};
const gisEvidence: EvidenceResolver = {
  module: "gis",
  kinds: ["condition", "valve"],
  find: async (_tx, kind, id) => (id === "log1" ? { kind, id, assetId: "g1", recordedByUserId: "u1", recordedAt: new Date(0) } : null),
};
const kind = (key: string, overrides: Partial<WorkKindDef> = {}): WorkKindDef => ({
  key,
  module: "gis",
  label: key,
  target: "asset",
  review: "none",
  tier: "basic",
  gis: "logs",
  ...overrides,
});

describe("work registry: assets and evidence", () => {
  it("resolves assets only through licensed modules, and omits what nobody recognises", async () => {
    const work = new WorkRegistry();
    work.registerAssetResolver(gisAssets);
    expect([...(await work.resolveAssets(tx, ["g1", "x9"], on("gis"))).keys()]).toEqual(["g1"]);
    expect((await work.resolveAssets(tx, ["g1"], on("billing"))).size).toBe(0);
    expect((await work.resolveAssets(tx, [], on("gis"))).size).toBe(0);
  });

  it("finds evidence by kind, and nothing when the module is unlicensed or the record is missing", async () => {
    const work = new WorkRegistry();
    work.registerEvidenceResolver(gisEvidence);
    expect((await work.findEvidence(tx, "valve", "log1", on("gis")))?.assetId).toBe("g1");
    expect(await work.findEvidence(tx, "valve", "nope", on("gis"))).toBeNull();
    expect(await work.findEvidence(tx, "valve", "log1", on())).toBeNull();
    expect(await work.findEvidence(tx, "unknown", "log1", on("gis"))).toBeNull();
  });

  it("refuses the same module or evidence kind twice", () => {
    const work = new WorkRegistry();
    work.registerAssetResolver(gisAssets);
    expect(() => work.registerAssetResolver(gisAssets)).toThrow(/already registered/);
    work.registerEvidenceResolver(gisEvidence);
    expect(() => work.registerEvidenceResolver({ ...gisEvidence, module: "inventory" })).toThrow(/already claimed/);
  });
});

describe("work registry: branch guard", () => {
  const woGuard: BranchGuard = {
    prefix: "wo-",
    check: async (_tx, write) => (write.userId === "assignee" ? { allowed: true } : { allowed: false, reason: "Not your job" }),
  };
  const write = (branch: string, userId = "assignee") => ({
    organizationId: "o",
    userId,
    permissions: new Set<Permission>(["work_orders:execute"]),
    branch,
  });

  it("leaves main and ordinary branches alone", async () => {
    const work = new WorkRegistry();
    expect(await work.checkBranchWrite(tx, write("main"))).toEqual({ allowed: true });
    expect(await work.checkBranchWrite(tx, write("field-visit"))).toEqual({ allowed: true });
  });

  it("hands a reserved branch to its guard, whatever the letter case", async () => {
    const work = new WorkRegistry();
    work.registerBranchGuard(woGuard);
    expect(await work.checkBranchWrite(tx, write("wo-1042"))).toEqual({ allowed: true });
    expect((await work.checkBranchWrite(tx, write("WO-1042", "someone-else"))).allowed).toBe(false);
  });

  it("fails closed: a reserved prefix with no guard is refused", async () => {
    const work = new WorkRegistry();
    work.reserveBranchPrefix("wo-");
    expect((await work.checkBranchWrite(tx, write("wo-1042"))).allowed).toBe(false);
    expect((await work.checkBranchWrite(tx, write("Wo-1042"))).allowed).toBe(false);
  });

  it("allows a prefix nobody reserved", async () => {
    expect((await new WorkRegistry().checkBranchWrite(tx, write("wo-1042"))).allowed).toBe(true);
  });

  it("rejects overlapping or malformed guard prefixes", () => {
    const work = new WorkRegistry();
    work.registerBranchGuard(woGuard);
    expect(() => work.registerBranchGuard({ ...woGuard, prefix: "wo-x" })).toThrow(/overlaps/);
    expect(() => work.registerBranchGuard({ ...woGuard, prefix: "" })).toThrow(/non-empty/);
    expect(() => work.registerBranchGuard({ ...woGuard, prefix: "WO-" })).toThrow(/lower-case/);
  });
});

describe("work registry: kinds", () => {
  it("offers a module's basic kinds when it is licensed, and full kinds only with Work Orders (W-01)", () => {
    const work = new WorkRegistry();
    work.registerWorkKind(kind("leak"));
    work.registerWorkKind(kind("survey_program", { tier: "full" }));
    work.registerWorkKind(kind("meter_install", { module: "metering", tier: "full", gis: "none" }));

    expect(work.availableKinds(on("gis"), workLevel(on("gis"))).map((k) => k.key)).toEqual(["leak"]);
    expect(work.availableKinds(on("gis", "work-orders"), workLevel(on("gis", "work-orders"))).map((k) => k.key)).toEqual(["leak", "survey_program"]);
    expect(work.availableKinds(on("accounts", "metering", "work-orders"), "full").map((k) => k.key)).toEqual(["meter_install"]);
    expect(work.availableKinds(on("metering"), workLevel(on("accounts", "metering")))).toEqual([]);
  });

  it("refuses duplicate or badly named kinds, and basic kinds from modules that need Work Orders", () => {
    const work = new WorkRegistry();
    work.registerWorkKind(kind("leak"));
    expect(() => work.registerWorkKind(kind("leak"))).toThrow(/already registered/);
    expect(() => work.registerWorkKind(kind("Not Snake"))).toThrow(/lower_snake_case/);
    expect(() => work.registerWorkKind(kind("disconnection", { module: "collections" }))).toThrow(/basic kinds/);
    expect(work.getWorkKind("leak")?.key).toBe("leak");
    expect(work.getWorkKind("missing")).toBeUndefined();
  });

  it("knows each organization's work level", () => {
    expect(workLevel([])).toBe("none");
    expect(workLevel(["accounts", "metering"])).toBe("none");
    expect(workLevel(["gis"])).toBe("basic");
    expect(workLevel(["gis", "work-orders"])).toBe("full");
    expect(workLevel(["work-orders"])).toBe("full");
  });
});

describe("work registry: branch annotators and effects", () => {
  const annotator: BranchAnnotator = {
    prefix: "wo-",
    annotate: async (_tx, branches) =>
      new Map(branches.filter((b) => b === "wo-1").map((b) => [b, { kind: "work_order", ref: "WO-1", id: "x", title: "T", status: "in_progress" }])),
  };

  it("labels only the branches its prefix covers, and only the ones it recognises", async () => {
    const work = new WorkRegistry();
    work.registerBranchAnnotator(annotator);
    expect([...(await work.annotateBranches(tx, ["wo-1", "wo-2", "field-visit", "WO-1"])).keys()]).toEqual(["wo-1"]);
  });

  it("returns nothing without an annotator, and rejects overlapping prefixes", async () => {
    expect((await new WorkRegistry().annotateBranches(tx, ["wo-1"])).size).toBe(0);
    const work = new WorkRegistry();
    work.registerBranchAnnotator(annotator);
    expect(() => work.registerBranchAnnotator({ ...annotator, prefix: "wo-x" })).toThrow(/overlaps/);
  });

  it("runs effects of licensed modules only, once per module", async () => {
    const work = new WorkRegistry();
    const ran: string[] = [];
    work.registerEffects({ module: "gis", onApprove: async (_tx, e) => void ran.push(`gis:${e.branch}`) });
    work.registerEffects({ module: "inventory", onApprove: async () => void ran.push("inventory") });
    expect(() => work.registerEffects({ module: "gis" })).toThrow(/already registered/);
    const event = { organizationId: "o", workOrderId: "w", kind: "leak", actorUserId: "u", branch: "wo-1" };
    await work.runEffects("onApprove", tx, event, on("gis"));
    await work.runEffects("onSubmit", tx, event, on("gis", "inventory"));
    expect(ran).toEqual(["gis:wo-1"]);
    expect(await work.openWorkOn(tx, "g1")).toEqual([]);
  });
});
