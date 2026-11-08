import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";
import { parse, stringify } from "superjson";
import { diffRows } from "./diff";

/**
 * This phone's copy of everything: what the server last said, plus what's been done here since. One
 * database per signed-in person, so people sharing a phone don't see each other's unsent work.
 *
 * Rows are superjson documents (Dates and bigints survive), not mirrored columns: `useApp()` is what
 * screens read, and this only has to get it back after a restart. It uses SQLite's synchronous API
 * on purpose. Saving happens in a layout effect, so an action's record and its queue item are
 * committed together, in one transaction, before anything on screen says "saved".
 */

const SCHEMA_VERSION = 1;

export function openUserDb(userId: string): SQLiteDatabase {
  const db = openDatabaseSync(`flowless-${userId.replace(/[^A-Za-z0-9_-]/g, "_")}.db`);
  const row = db.getFirstSync<{ user_version: number }>("PRAGMA user_version");
  if ((row?.user_version ?? 0) < SCHEMA_VERSION) {
    db.execSync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS records (
        collection TEXT NOT NULL,
        key TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (collection, key)
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, json TEXT NOT NULL);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }
  return db;
}

/** A collection's rows in the order they were first saved (rowid survives an upsert). */
export function loadRows<T>(db: SQLiteDatabase, collection: string): T[] {
  return db
    .getAllSync<{ json: string }>("SELECT json FROM records WHERE collection = ? ORDER BY rowid", collection)
    .map((row) => parse<T>(row.json));
}

export function loadMeta<T>(db: SQLiteDatabase): T | null {
  const row = db.getFirstSync<{ json: string }>("SELECT json FROM meta WHERE key = 'app'");
  return row ? parse<T>(row.json) : null;
}

export type CollectionChange<T = unknown> = { collection: string; previous: readonly T[]; next: readonly T[]; keyOf: (row: T) => string };

/** Everything that changed in one state update, all or nothing. */
export function saveChanges(db: SQLiteDatabase, changes: CollectionChange[], meta: { previous: string | null; next: string }) {
  const work = changes.map((c) => ({ ...c, diff: diffRows(c.previous, c.next, c.keyOf) })).filter((c) => c.diff.upserts.length > 0 || c.diff.deletes.length > 0);
  if (work.length === 0 && meta.previous === meta.next) return;
  db.withTransactionSync(() => {
    for (const { collection, keyOf, diff } of work) {
      for (const row of diff.upserts) {
        db.runSync(
          "INSERT INTO records (collection, key, json) VALUES (?, ?, ?) ON CONFLICT (collection, key) DO UPDATE SET json = excluded.json",
          collection,
          keyOf(row),
          stringify(row),
        );
      }
      for (const key of diff.deletes) db.runSync("DELETE FROM records WHERE collection = ? AND key = ?", collection, key);
    }
    if (meta.previous !== meta.next) {
      db.runSync("INSERT INTO meta (key, json) VALUES ('app', ?) ON CONFLICT (key) DO UPDATE SET json = excluded.json", meta.next);
    }
  });
}

/** Meta is compared as text, so callers pass the stringified form. */
export const stringifyMeta = (meta: unknown) => stringify(meta);
