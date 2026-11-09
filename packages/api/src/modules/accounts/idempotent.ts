import type { Transaction } from "@flowless/db";
import { TRPCError } from "@trpc/server";
import { isUniqueViolation } from "../../kernel/pg-errors";

/*
 * The one idempotent-step mechanism (C-03, C-05, C-08 to C-10). A use case takes a
 * client-mintable id; the same id with the same request replays the earlier result and
 * anything else under that id is CONFLICT. The step log (`account_command`,
 * `application_event`, `relocation_event`) and the created rows (`application`,
 * `relocation`) differ only in the table and in what "the same request" means, so each is
 * a small `IdempotentStep` descriptor and every use case is `step.once(...)`: the descriptor
 * does the earlier-row lookup and the CONFLICT rule, the use case holds only its plan and effect.
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

export function idempotentStep<Row, Expected>(step: IdempotentStep<Row, Expected>): IdempotentStepRunner<Row, Expected> {
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

/**
 * A step in an append-only log (`account_command`, `application_event`, `relocation_event`):
 * the same id replays only for the same parent, kind, actor and request fingerprint.
 */
export function loggedStep<Row extends { kind: string; actorUserId: string | null; fingerprint: string | null }>(log: {
  find(tx: Transaction, id: string): Promise<Row | undefined>;
  parentOf(row: Row): string;
  conflict?: string;
}): IdempotentStepRunner<Row, LoggedStepExpected> {
  return idempotentStep<Row, LoggedStepExpected>({
    find: log.find,
    same: (earlier, expected, actorUserId) =>
      log.parentOf(earlier) === expected.parentId &&
      earlier.kind === expected.kind &&
      earlier.actorUserId === actorUserId &&
      earlier.fingerprint === expected.fingerprint,
    conflict: log.conflict ?? "That id was already used for a different request",
  });
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
