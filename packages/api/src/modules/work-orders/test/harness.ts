import type { Transaction } from "@flowless/db";
import type { TestDatabase } from "@flowless/db/testing";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { createFilesRouter } from "../../../kernel/files";
import { createMemoryStorage } from "../../../kernel/storage";
import { defineWorkKind, WorkRegistry, type AssetRef, type WorkKindDef } from "../../../kernel/work";
import { sessionOf, type Member } from "../../../test-support";
import { createCallerFactory, router } from "../../../trpc";
import { register, workOrderFileSubject } from "..";
import { createWorkOrdersRouter } from "../router";

/*
 * A work registry standing in for GIS: Majimap's GIS kinds (the ones its work-order tests
 * use) and in-memory asset and log resolvers that, like the real ones under RLS, only
 * answer for the transaction's organization. It keeps the Work Orders suites independent
 * of the GIS engine; the real GIS adapters are exercised end to end in
 * modules/gis/test/job-branches.test.ts (W3). Its logs carry no branch, so the
 * "logs from the job's branch" rule is tested there.
 */

const orgOf = async (tx: Transaction) =>
  (await tx.execute<{ org: string }>(sql`select current_setting('app.organization_id', true) as org`))[0]!.org;

interface FakeAsset {
  organizationId: string;
  ref: AssetRef;
}
interface FakeLog {
  organizationId: string;
  kind: "condition" | "valve";
  assetId: string;
  recordedByUserId: string;
}

const gisKind = (key: string, over: Partial<WorkKindDef>): WorkKindDef =>
  defineWorkKind({ key, module: "gis", label: key, target: "asset", review: "optional", tier: "basic", gis: "logs", ...over });

export const GIS_TEST_KINDS: readonly WorkKindDef[] = [
  gisKind("leak", { selfRaise: true }),
  gisKind("leak_survey", { target: "area", review: "required" }),
  gisKind("valve_replacement", { review: "required", gis: "edits" }),
  gisKind("valve_exercise", { target: "assets" }),
  gisKind("flushing", { review: "none" }),
  gisKind("inspection", { selfRaise: true }),
  gisKind("asset_capture", { target: "location", review: "required", gis: "creates", selfRaise: true }),
];

export function createHarness(t: TestDatabase) {
  const assets = new Map<string, FakeAsset>();
  const logs = new Map<string, FakeLog>();
  const work = new WorkRegistry();
  register(work);
  for (const k of GIS_TEST_KINDS) work.registerWorkKind(k);
  work.registerAssetResolver({
    module: "gis",
    async resolve(tx, ids) {
      const org = await orgOf(tx);
      const found = new Map<string, AssetRef>();
      for (const id of ids) {
        const a = assets.get(id);
        if (a && a.organizationId === org) found.set(id, a.ref);
      }
      return found;
    },
  });
  work.registerEvidenceResolver({
    module: "gis",
    kinds: ["condition", "valve"],
    async find(tx, kind, id) {
      const log = logs.get(id);
      if (!log || log.kind !== kind || log.organizationId !== (await orgOf(tx))) return null;
      return { kind, id, assetId: log.assetId, recordedByUserId: log.recordedByUserId, recordedAt: new Date() };
    },
  });

  const memory = createMemoryStorage();
  const testRouter = router({ workOrders: createWorkOrdersRouter(work), files: createFilesRouter([workOrderFileSubject]) });
  const factory = createCallerFactory(testRouter);
  const as = (m: Member) => factory({ db: t.app, session: sessionOf(m), storage: memory.storage });

  return {
    work,
    as,
    /** A GIS asset (a valve unless said otherwise) in `organizationId`. */
    asset(organizationId: string, over: Partial<AssetRef> = {}) {
      const id = randomUUID();
      assets.set(id, {
        organizationId,
        ref: { id, module: "gis", type: "valve", name: `Valve ${id.slice(0, 4)}`, location: null, state: "registered", possibleDuplicateOf: null, ...over },
      });
      return id;
    },
    /** A GIS log recorded by `m` on an asset. */
    log(m: Member, assetId: string, kind: "condition" | "valve" = "valve") {
      const id = randomUUID();
      logs.set(id, { organizationId: m.organizationId, kind, assetId, recordedByUserId: m.userId });
      return id;
    },
    /** Announces, "uploads" and confirms a photo on a job. */
    async photo(m: Member, workOrderId: string) {
      const input = { id: randomUUID(), subjectKind: "work_order", subjectId: workOrderId, fileName: "p.jpg", mimeType: "image/jpeg" as const, sizeBytes: 1000 };
      const { file, upload } = await as(m).files.announce(input);
      memory.put(upload!.url.replace("memory://", ""), input.sizeBytes);
      return (await as(m).files.confirm({ id: file.id })).file!;
    },
    announce(m: Member, workOrderId: string) {
      return as(m).files.announce({ id: randomUUID(), subjectKind: "work_order", subjectId: workOrderId, fileName: "p.jpg", mimeType: "image/jpeg", sizeBytes: 1000 });
    },
  };
}

export type Harness = ReturnType<typeof createHarness>;
export type Caller = ReturnType<Harness["as"]>;

export async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

export const somewhere = () => ({ latitude: -1.29 + Math.random() * 0.01, longitude: 36.8 + Math.random() * 0.01 });
