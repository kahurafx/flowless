import * as authSchema from "@flowless/db/auth-schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { twoFactor } from "better-auth/plugins/two-factor";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * Identity, sessions and organization membership (K-01, K-03, NF-05).
 * `db` must connect as a member of `flowless_auth`, the only role with access to
 * the `auth` schema; it has no access to any module schema.
 *
 * Phase 1 adds secret/baseURL wiring, access-control statements, audit hooks (K-06)
 * and the organization lifecycle events.
 */
export function createAuth(db: PostgresJsDatabase<typeof authSchema>) {
  return betterAuth({
    appName: "Flowless",
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema, schemaName: "auth" }),
    // UUIDs because tenant RLS policies compare organization_id as uuid.
    advanced: { database: { generateId: "uuid" } },
    emailAndPassword: { enabled: true },
    plugins: [organization(), twoFactor()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
