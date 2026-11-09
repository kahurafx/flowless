import type { Transaction } from "@flowless/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { ActionEnv } from "../../kernel/action-env";
import { isUniqueViolation } from "../../kernel/pg-errors";

/*
 * The one idempotent-step mechanism (C-03, C-05, C-08 to C-10). A use case takes a
 * client-mintable id; the same id with the same request replays the earlier result and
 * anything else under that id is CONFLICT. The step logs (`account_command`,
 * `application_event`, `relocation_event`: one `defineStepLog` each) and the created rows
 * (`application`, `relocation`: `createdStep`) differ only in the table and in what "the
 * same request" means, and every use case is `log.once(...)`: the descriptor does the
 * earlier-row lookup and the CONFLICT rule, the use case holds only its plan and effect.
 */

/** Who is acting: the system has no user. */
interface Actor {
  tx: Transaction;
  actor: { userId: string | null };
}

export interface IdempotentStep<Row, Expected> {
  /** The earlier row under this id, if any. */
  find(tx: Transaction, id: string): Promise<Row | undefined>;
  /** Is the earlier row the same request as the one now asked for, by the same actor? */
  same(earlier: Row, expected: Expected, actorUserId: string | null): boolean;
  /** CONFLICT message when the id belongs to a different request. */
  conflict: string;
}

export type Replayable<R> = R & { replayed: boolean };

export interface IdempotentStepRunner<Row, Expected> {
  /**
   * Runs `run` unless `id` was already used by the same request, in which case `replay`
   * builds the earlier result from the earlier row. The result carries `replayed`.
   * Without an id there is nothing to replay.
   */
  once<R extends object>(
    env: Actor,
    id: string | undefined,
    expected: Expected,
    steps: { replay(earlier: Row): R | Promise<R>; run(): R | Promise<R> },
  ): Promise<Replayable<R>>;
}

function idempotentStep<Row, Expected>(step: IdempotentStep<Row, Expected>): IdempotentStepRunner<Row, Expected> {
  return {
    async once(env, id, expected, { replay, run }) {
      if (id) {
        const earlier = await step.find(env.tx, id);
        if (earlier) {
          if (!step.same(earlier, expected, env.actor.userId)) throw new TRPCError({ code: "CONFLICT", message: step.conflict });
          return { ...(await replay(earlier)), replayed: true };
        }
      }
      return { ...(await run()), replayed: false };
    },
  };
}

/** What a logged step must repeat to count as a retry. */
export interface LoggedStepExpected {
  /** The row the step belongs to (account, application or relocation). */
  parentId: string;
  kind: string;
  fingerprint: string;
}

/** What every step-log table has in common; each also has its own parent column and its own state columns. */
type StepLogTable = PgTable & {
  id: PgColumn;
  organizationId: PgColumn;
  $inferSelect: { id: string; kind: string; actorUserId: string | null; fingerprint: string | null };
};

/** The columns `append` fills itself; the caller gives the rest of the table's row (kind, reason, state columns, payload, fingerprint, optional client id). */
type Filled = "organizationId" | "actorUserId" | "source" | "occurredAt";

/**
 * One append-only step log with a client-mintable id (`account_command`, `application_event`,
 * `relocation_event`): `table` is the log's table and `parent` the name of its column for the
 * row a step belongs to (account, application or relocation). The tables name their state
 * columns differently (two status axes, a stage, a status), so a step carries those columns
 * itself, typed by the table.
 *
 * - `append(env, parentId, step)` inserts the row for the acting user or the system; a unique
 *   violation on the client's id is CONFLICT.
 * - `once(env, id, expected, { replay, run })` is the idempotent wrapper: the same id replays
 *   only for the same parent, kind, actor and request fingerprint; anything else is CONFLICT.
 */
export function defineStepLog<T extends StepLogTable, P extends keyof T["$inferSelect"] & keyof T["$inferInsert"] & string>(table: T, parent: P) {
  type Row = T["$inferSelect"];
  type Step = { reason: string } & Omit<T["$inferInsert"], Filled | P>;
  const runner = idempotentStep<Row, LoggedStepExpected>({
    find: async (tx, id) => (await tx.select().from(table as PgTable).where(eq(table.id, id)))[0] as Row | undefined,
    same: (earlier, expected, actorUserId) =>
      (earlier[parent] as unknown as string) === expected.parentId &&
      earlier.kind === expected.kind &&
      earlier.actorUserId === actorUserId &&
      earlier.fingerprint === expected.fingerprint,
    conflict: "That id was already used for a different request",
  });
  return {
    once: runner.once,
    async append(env: ActionEnv, parentId: string, step: Step): Promise<Row> {
      const values = { ...step, reason: step.reason.trim(), organizationId: env.organizationId, [parent]: parentId, actorUserId: env.actor.userId, source: env.source };
      const [row] = await claimingId(() => env.tx.insert(table as PgTable).values(values as never).returning());
      return row as Row;
    },
  };
}

/**
 * A step that creates a row under the client's id (an application, a relocation): a repeat by
 * the person who created it replays; the id under anyone else's row is CONFLICT.
 */
export function createdStep<Row>(created: {
  find(tx: Transaction, id: string): Promise<Row | undefined>;
  creatorOf(row: Row): string | null;
}): IdempotentStepRunner<Row, void> {
  return idempotentStep<Row, void>({
    find: created.find,
    same: (earlier, _expected, actorUserId) => created.creatorOf(earlier) === actorUserId,
    conflict: ID_IN_USE,
  });
}

export const ID_IN_USE = "That id is already in use";

/** Runs an insert that carries a client-minted id: a unique violation means the id is taken, which is CONFLICT. */
export async function claimingId<T>(insert: () => Promise<T>, message = ID_IN_USE): Promise<T> {
  try {
    return await insert();
  } catch (error) {
    if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message });
    throw error;
  }
}
