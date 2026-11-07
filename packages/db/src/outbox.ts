import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { outboxEvent } from "./schema/kernel";

export interface OutboxEntry {
  organizationId: string;
  type: string;
  version?: number;
  payload: unknown;
  /** A stable id chosen by the publisher, so publishing twice is harmless. */
  id?: string;
}

/**
 * Writes an event to the outbox (K-09). Use the caller's transaction so the event
 * commits only with the change it describes. Publishing an id that already exists is a
 * no-op. The api's `ctx.publish` validates payloads against the event catalogue; this
 * raw form is for packages that cannot import the api (packages/auth).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any drizzle Postgres database or transaction
export async function enqueueEvent(db: PgDatabase<PgQueryResultHKT, any>, entry: OutboxEntry): Promise<void> {
  await db
    .insert(outboxEvent)
    .values({ ...entry, payload: entry.payload ?? {} })
    .onConflictDoNothing();
}
