import { createDatabase, type Database, type DatabaseHandle } from "@flowless/db";

// Reuse one pool across dev hot reloads instead of opening a new one per reload.
const globalForDb = globalThis as typeof globalThis & { flowlessDb?: DatabaseHandle };

/** Created on first use, so `next build` never needs database env. */
export function getDb(): Database {
  if (!globalForDb.flowlessDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
    globalForDb.flowlessDb = createDatabase(url);
  }
  return globalForDb.flowlessDb.db;
}
