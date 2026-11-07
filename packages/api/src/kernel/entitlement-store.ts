import { organizationModule, recordAudit, withTenant, type Database, type Transaction } from "@flowless/db";
import { entitlementProblem, isModuleKey, MODULE_KEYS, type ModuleKey } from "@flowless/shared-types";
import { asc } from "drizzle-orm";

/** The modules this organization is licensed for (K-04), in catalogue order. Runs under RLS. */
export async function loadEntitlements(tx: Transaction): Promise<ModuleKey[]> {
  const rows = await tx.select({ module: organizationModule.module }).from(organizationModule).orderBy(asc(organizationModule.module));
  const on = new Set(rows.map((r) => r.module).filter(isModuleKey));
  return MODULE_KEYS.filter((m) => on.has(m));
}

/**
 * Replaces an organization's licensed modules. Server-side only: Flowless sets licences
 * when onboarding or changing a plan, so this is not a procedure and no tenant can call
 * it. Rejects unknown modules and modules whose dependencies are missing.
 */
export async function setEntitlements(
  db: Database,
  organizationId: string,
  modules: readonly string[],
  /** Who at Flowless made the change, and why; recorded in the tenant's audit log. */
  by: { label: string; reason?: string } = { label: "Flowless" },
): Promise<ModuleKey[]> {
  const unknown = modules.filter((m) => !isModuleKey(m));
  if (unknown.length) throw new Error(`Unknown module: ${unknown.join(", ")}`);
  const wanted = [...new Set(modules as ModuleKey[])];
  const problem = entitlementProblem(wanted);
  if (problem) throw new Error(`Cannot license this set: ${problem}`);

  return withTenant(db, organizationId, async (tx) => {
    const before = await loadEntitlements(tx);
    await tx.delete(organizationModule);
    if (wanted.length) await tx.insert(organizationModule).values(wanted.map((module) => ({ organizationId, module })));
    const after = await loadEntitlements(tx);
    if (before.join() !== after.join()) {
      await recordAudit(tx, {
        organizationId,
        source: "system",
        action: "entitlements.set",
        actorLabel: by.label,
        reason: by.reason ?? null,
        before,
        after,
      });
    }
    return after;
  });
}
