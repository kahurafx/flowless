import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { auditLog } from "./schema/kernel";

/** Where an audited action came from (K-06). */
export const AUDIT_SOURCES = ["web", "mobile", "api", "import", "system", "support"] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export interface AuditEntry {
  organizationId: string;
  source: AuditSource;
  /** "<area>.<verb>", e.g. "access.grant". */
  action: string;
  actorUserId?: string | null;
  actorLabel?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ipAddress?: string | null;
}

/**
 * Appends one audit entry. Use the caller's transaction, so the entry commits or rolls
 * back with the change it describes. Time, chain position and hashes are set by the
 * database (`kernel.audit_chain`), never here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any drizzle Postgres database or transaction
export async function recordAudit(db: PgDatabase<PgQueryResultHKT, any>, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    ...entry,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}
