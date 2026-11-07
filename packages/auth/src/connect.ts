import * as authSchema from "@flowless/db/auth-schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createAuth, type Auth } from "./auth";

/**
 * Connects Better Auth to the `auth` schema. `databaseUrl` is DATABASE_AUTH_URL: a login
 * role in `flowless_auth`. Only this package touches the auth schema (build plan).
 */
export function connectAuth(databaseUrl: string): { auth: Auth; close: () => Promise<void> } {
  const client = postgres(databaseUrl);
  return { auth: createAuth(drizzle(client, { schema: authSchema })), close: () => client.end() };
}
