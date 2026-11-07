import { connectAuth, type Auth, type AuthConnection } from "@flowless/auth";

// One Better Auth instance per process, reused across dev hot reloads.
const globalForAuth = globalThis as typeof globalThis & { flowlessAuth?: AuthConnection };

/** Created on first use, so `next build` never needs database or auth env. */
function connection(): AuthConnection {
  if (!globalForAuth.flowlessAuth) {
    const url = process.env.DATABASE_AUTH_URL;
    if (!url) throw new Error("DATABASE_AUTH_URL is not set (see .env.example)");
    globalForAuth.flowlessAuth = connectAuth(url);
  }
  return globalForAuth.flowlessAuth;
}

export const getAuth = (): Auth => connection().auth;

/** The session plus the caller's current membership (role), for the API (K-03). */
export const getCaller: AuthConnection["getCaller"] = (headers) => connection().getCaller(headers);
