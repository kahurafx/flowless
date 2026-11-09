import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { DATA_QUALITY_RULE_KEYS, MODULE_KEYS, moduleMatrix, type ModuleKey } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { escalateApprovals } from "./kernel/approval-store";
import { consumers } from "./kernel/consumers";
import { setEntitlements } from "./kernel/entitlement-store";
import { dispatchOutbox } from "./kernel/events";
import { jobs } from "./kernel/job-registry";
import { runJobs } from "./kernel/jobs";
import { sweepDataQuality, sweepStaleAccounts } from "./modules/accounts";
import { sweepOverdueWorkOrders } from "./modules/work-orders";
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
/**
 * A router several modules bring, mounted at the first one's key: it answers while any of
 * them is licensed. Work Orders comes with GIS alone at level basic (W-01).
 */
const SHARED: Partial<Record<ModuleKey, readonly ModuleKey[]>> = { "work-orders": ["work-orders", "gis"] };
/** The modules that license a path's router, or undefined for a kernel router. */
const modulesOf = (path: string): readonly ModuleKey[] | undefined => {
  const owner = MODULE_KEYS.find((m) => routerKey(m) === path.split(".")[0]);
  return owner ? (SHARED[owner] ?? [owner]) : undefined;
};

let t: TestDatabase;
let owner: Member;
beforeAll(async () => {
  t = await startTestDatabase();
  owner = await addMember(t, tenants.a.id, "owner");
  // Something for the data-quality sweep to find in every combination where Accounts is licensed: an account with no phone,
  // no service point and no category, with every rule raising exceptions.
  await setEntitlements(t.app, tenants.a.id, ["accounts"]);
  const caller = callerFor(t, owner);
  const customer = await caller.accounts.customers.create({ type: "person", name: "Matrix customer" });
  await caller.accounts.create({ customerId: customer.id });
  const rules = Object.fromEntries(DATA_QUALITY_RULE_KEYS.map((rule) => [rule, { raiseExceptions: true }]));
  await caller.config.set({ key: "accounts.data_quality", value: { rules }, expectedVersion: 0 });
});
afterAll(() => t?.stop());

// NF-31: absent modules never break others, for each module combination.
describe("module combination matrix", () => {
  it("mounts only kernel routers and module routers", () => {
    const strays = procedures().filter((p) => !KERNEL.has(p.path.split(".")[0]!) && !modulesOf(p.path));
    expect(strays.map((p) => p.path)).toEqual([]);
  });

  for (const combo of moduleMatrix()) {
    it(`${combo.name}: every endpoint answers, unlicensed modules are not found, the worker runs`, async () => {
      await setEntitlements(t.app, tenants.a.id, combo.modules);
      const caller = callerFor(t, owner);
      const broken: string[] = [];
      for (const { path } of procedures()) {
        const modules = modulesOf(path);
        const licensed = !modules || modules.some((m) => combo.modules.includes(m));
        const module = modules?.join(" or ");
        try {
          await callPath(caller, path, undefined);
          if (!licensed) broken.push(`${path} answered while ${module} is unlicensed`);
        } catch (error) {
          const code = error instanceof TRPCError ? error.code : "NOT_A_TRPC_ERROR";
          if (!licensed && code !== "NOT_FOUND") broken.push(`${path}: ${code}, expected NOT_FOUND while ${module} is unlicensed`);
          if (licensed && (code === "INTERNAL_SERVER_ERROR" || code === "NOT_A_TRPC_ERROR")) {
            broken.push(`${path}: ${(error as Error).message}`);
          }
          // A shared router must not refuse its licence while one of its modules is licensed.
          if (licensed && code === "NOT_FOUND" && (error as Error).message.includes("not licensed")) {
            broken.push(`${path}: refused as unlicensed while ${module} is licensed`);
          }
        }
      }
      expect(broken).toEqual([]);

      await expect(dispatchOutbox(t.app, consumers)).resolves.toBeTruthy();
      await expect(runJobs(t.app, jobs)).resolves.toMatchObject({ failed: 0 });
      await expect(escalateApprovals(t.app)).resolves.toBeTypeOf("number");
      await expect(sweepOverdueWorkOrders(t.app)).resolves.toBeTypeOf("number");
      await expect(sweepStaleAccounts(t.app)).resolves.toBeTypeOf("number");
      await expect(sweepDataQuality(t.app)).resolves.toBeTypeOf("number");
    });
  }
});
