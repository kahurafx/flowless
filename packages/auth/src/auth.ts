import * as authSchema from "@flowless/db/auth-schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { twoFactor } from "better-auth/plugins/two-factor";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export type AuthDatabase = PostgresJsDatabase<typeof authSchema>;

/**
 * Identity, sessions and organization membership (K-01, K-03, NF-05).
 * `db` must connect as a member of `flowless_auth`, the only role with access to
 * the `auth` schema; it has no access to any module schema.
 *
 * Secret and base URL come from BETTER_AUTH_SECRET and BETTER_AUTH_URL.
 * Still to come in Phase 1: access-control statements (A2), audit hooks (K-06, A5)
 * and organization lifecycle events (A6).
 */
export function createAuth(db: AuthDatabase) {
  return betterAuth({
    appName: "Flowless",
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema, schemaName: "auth" }),
    // UUIDs because tenant RLS policies compare organization_id as uuid.
    advanced: { database: { generateId: "uuid" } },
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    // Brute-force protection (NF-05), on in every environment, stricter on sign-in.
    // In-memory per instance for now; move to shared storage when web scales out.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: { "/sign-in/email": { window: 60, max: 5 }, "/two-factor/*": { window: 60, max: 5 } },
    },
    plugins: [organization(), twoFactor()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** The full Better Auth session (user + session, with organization plugin fields). */
export type AuthSession = Auth["$Infer"]["Session"];
