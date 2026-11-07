import { exception, type Transaction } from "@flowless/db";
import type { ExceptionSubjectKind, ExceptionType, ModuleKey } from "@flowless/shared-types";
import { and, eq, ne, sql } from "drizzle-orm";
import { isForeignKeyViolation } from "./pg-errors";

export interface RaiseException {
  type: ExceptionType;
  source: ModuleKey | "kernel";
  title: string;
  detail?: string;
  subject: { kind: ExceptionSubjectKind; ref: string };
  /** Where it belongs, so scoped members see it (K-03). */
  areaId?: string | null;
  routeId?: string | null;
  /** Who should act (NF-24). Unassigned when null or no longer a member. */
  ownerUserId?: string | null;
  /** One open exception per key: raising again counts an occurrence instead. */
  dedupeKey?: string;
}

/**
 * Puts a problem in the exception queue (X-02, NF-24) inside the caller's tenant
 * transaction. With a `dedupeKey`, an open exception for the same key is updated
 * (occurrences, last seen, detail) rather than duplicated.
 */
export async function raiseException(tx: Transaction, organizationId: string, input: RaiseException): Promise<{ id: string }> {
  const insert = (ownerUserId: string | null) =>
    // A savepoint, so an owner who left (foreign key) does not abort the caller's transaction.
    tx.transaction(async (sp) => {
      const values = {
        organizationId,
        type: input.type,
        source: input.source,
        title: input.title,
        detail: input.detail ?? "",
        subjectKind: input.subject.kind,
        subjectRef: input.subject.ref,
        areaId: input.areaId ?? null,
        routeId: input.routeId ?? null,
        ownerUserId,
        dedupeKey: input.dedupeKey ?? null,
      };
      const query = sp.insert(exception).values(values);
      const [row] = input.dedupeKey
        ? await query
            .onConflictDoUpdate({
              target: [exception.organizationId, exception.dedupeKey],
              targetWhere: sql`${exception.status} <> 'resolved'`,
              set: { occurrences: sql`${exception.occurrences} + 1`, lastSeenAt: sql`now()`, detail: values.detail },
            })
            .returning({ id: exception.id })
        : await query.returning({ id: exception.id });
      return row!;
    });

  try {
    return await insert(input.ownerUserId ?? null);
  } catch (error) {
    if (input.ownerUserId && isForeignKeyViolation(error)) return insert(null);
    throw error;
  }
}

/** Resolves the open exception for `dedupeKey`, if any: the problem went away by itself. */
export async function resolveByDedupeKey(tx: Transaction, dedupeKey: string, note: string): Promise<void> {
  await tx
    .update(exception)
    .set({ status: "resolved", resolvedAt: new Date(), resolutionNote: note })
    .where(and(eq(exception.dedupeKey, dedupeKey), ne(exception.status, "resolved")));
}
