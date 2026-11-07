import { connectAuth, type Auth } from "@flowless/auth";

// One Better Auth instance per process, reused across dev hot reloads.
const globalForAuth = globalThis as typeof globalThis & { flowlessAuth?: ReturnType<typeof connectAuth> };

/** Created on first use, so `next build` never needs database or auth env. */
export function getAuth(): Auth {
  if (!globalForAuth.flowlessAuth) {
    const url = process.env.DATABASE_AUTH_URL;
    if (!url) throw new Error("DATABASE_AUTH_URL is not set (see .env.example)");
    globalForAuth.flowlessAuth = connectAuth(url);
  }
  return globalForAuth.flowlessAuth.auth;
}
