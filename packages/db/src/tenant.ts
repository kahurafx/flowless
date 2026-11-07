import { sql } from "drizzle-orm";
import { pgPolicy, pgRole, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { Database, Transaction } from "./client";

/** Group role every runtime connection belongs to. Created by `bootstrapRoles`. */
export const appRole = pgRole("flowless_app").existing();

/** Group role of the Better Auth connection. Reaches only `auth`, plus insert-only audit. */
export const authRole = pgRole("flowless_auth").existing();

/**
 * The organization of the current transaction, or NULL when none is set.
 * NULL matches no row, so a query outside `withTenant` sees nothing (fails closed).
 */
const currentOrganizationId = sql`nullif(current_setting('app.organization_id', true), '')::uuid`;

/** The RLS policy every tenant-scoped table uses (K-01, NF-01). */
export function tenantPolicy(column: AnyPgColumn) {
  return pgPolicy("tenant_isolation", {
    for: "all",
    to: appRole,
    using: sql`${column} = ${currentOrganizationId}`,
    withCheck: sql`${column} = ${currentOrganizationId}`,
  });
}

/**
 * Runs `fn` in a transaction scoped to one organization. The setting is
 * transaction-local, so it never leaks to another request on a pooled connection.
 */
export function withTenant<T>(
  db: Database,
  organizationId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
    return fn(tx);
  });
}
