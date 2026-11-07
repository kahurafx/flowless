import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DatabaseHandle {
  db: Database;
  close: () => Promise<void>;
}

export function createDatabase(url: string, options: { max?: number } = {}): DatabaseHandle {
  const client = postgres(url, options);
  return {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  };
}

/** Liveness check that touches no tenant data. */
export async function ping(db: Database): Promise<void> {
  await db.execute(sql`select 1`);
}
