import * as authSchema from "@flowless/db/auth-schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createAuth, type Auth, type AuthSession } from "./auth";
import { membershipOf } from "./membership";

/** The signed-in caller: the Better Auth session plus their one membership, read fresh. */
export type Caller = AuthSession & { member: { organizationId: string; role: string } | null };

export interface AuthConnection {
  auth: Auth;
  /**
   * Resolves the caller from request headers. The membership is read on every call, so
   * removing a member or changing their role takes effect on their next request (K-03).
   */
  getCaller: (headers: Headers) => Promise<Caller | null>;
  close: () => Promise<void>;
}

/**
 * Connects Better Auth to the `auth` schema. `databaseUrl` is DATABASE_AUTH_URL: a login
 * role in `flowless_auth`. Only this package touches the auth schema (build plan).
 */
export function connectAuth(databaseUrl: string): AuthConnection {
  const client = postgres(databaseUrl);
  const db = drizzle(client, { schema: authSchema });
  const auth = createAuth(db);
  return {
    auth,
    getCaller: async (headers) => {
      const session = await auth.api.getSession({ headers });
      if (!session) return null;
      return { ...session, member: await membershipOf(db, session.user.id) };
    },
    close: () => client.end(),
  };
}
