import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { MODULE_KEYS, moduleMatrix, type ModuleKey } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { escalateApprovals } from "./kernel/approval-store";
import { consumers } from "./kernel/consumers";
import { setEntitlements } from "./kernel/entitlement-store";
import { dispatchOutbox } from "./kernel/events";
import { jobs } from "./kernel/job-registry";
import { runJobs } from "./kernel/jobs";
import { addMember, callerFor, callPath, procedures, type Member } from "./test-support";

/** Kernel routers: always mounted. Every other top-level key must be a module's. */
const KERNEL = new Set([
  "health",
  "organization",
  "config",
  "access",
  "hierarchy",
  "entitlements",
  "audit",
  "exceptions",
  "approvals",
  "files",
  "notifications",
  "support",
]);
/** Module routers are mounted at the camelCase of their module key ("work-orders" → workOrders). */
const routerKey = (m: ModuleKey) => m.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const moduleOf = (path: string) => MODULE_KEYS.find((m) => routerKey(m) === path.split(".")[0]);

let t: TestDatabase;
let owner: Member;
beforeAll(async () => {
  t = await startTestDatabase();
  owner = await addMember(t, tenants.a.id, "owner");
});
afterAll(() => t?.stop());

// NF-31: absent modules never break others, for each module combination.
describe("module combination matrix", () => {
  it("mounts only kernel routers and module routers", () => {
    const strays = procedures().filter((p) => !KERNEL.has(p.path.split(".")[0]!) && !moduleOf(p.path));
    expect(strays.map((p) => p.path)).toEqual([]);
  });

  for (const combo of moduleMatrix()) {
    it(`${combo.name}: every endpoint answers, unlicensed modules are not found, the worker runs`, async () => {
      await setEntitlements(t.app, tenants.a.id, combo.modules);
      const caller = callerFor(t, owner);
      const broken: string[] = [];
      for (const { path } of procedures()) {
        const module = moduleOf(path);
        const licensed = !module || combo.modules.includes(module);
        try {
          await callPath(caller, path, undefined);
          if (!licensed) broken.push(`${path} answered while ${module} is unlicensed`);
        } catch (error) {
          const code = error instanceof TRPCError ? error.code : "NOT_A_TRPC_ERROR";
          if (!licensed && code !== "NOT_FOUND") broken.push(`${path}: ${code}, expected NOT_FOUND while ${module} is unlicensed`);
          if (licensed && (code === "INTERNAL_SERVER_ERROR" || code === "NOT_A_TRPC_ERROR")) {
            broken.push(`${path}: ${(error as Error).message}`);
          }
        }
      }
      expect(broken).toEqual([]);

      await expect(dispatchOutbox(t.app, consumers)).resolves.toBeTruthy();
      await expect(runJobs(t.app, jobs)).resolves.toMatchObject({ failed: 0 });
      await expect(escalateApprovals(t.app)).resolves.toBeTypeOf("number");
    });
  }
});
