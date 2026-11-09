import { relocation, relocationEvent } from "@flowless/db/schema/accounts";
import type { RelocationEventKind, RelocationStatus } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { Viewer } from "./access";
import type { ActionEnv } from "../../kernel/action-env";
import type { AuditNote } from "../../trpc";
import { lockAccount } from "./commands";
import { createdStep, defineStepLog } from "./idempotent";
import { findRelocation, isOpen, toRelocationDto, type RelocationRow } from "./relocation-present";
import type { AccountRow } from "./service";

/*
 * The relocation's step log (table `relocation_event`) and the steps that share its shape
 * (C-09): a client-mintable id, a fingerprint, replay for the same request and CONFLICT for
 * any other (`idempotent.ts`), and a database trigger that refuses a status change without a row.
 */

/**
 * The relocation step log: `append` a step, `once` replays a repeat (the same id for the same
 * relocation, kind, actor and request). Not every kind moves the status: `work_recorded` rows
 * (and a `survey_recorded` that leaves it where it was) have from = to.
 */
export const relocationLog = defineStepLog(relocationEvent, "relocationId");

/** The idempotency of `request`: a repeat of the creator's own id replays. */
export const relocationCreation = createdStep<RelocationRow>({
  find: async (tx, id) => (await tx.select().from(relocation).where(eq(relocation.id, id)))[0],
  creatorOf: (r) => r.requestedByUserId,
});

/**
 * Locks the relocation's account, then the relocation, in that order (the order every use
 * case takes, so two of them on one relocation take turns). A hidden relocation or account
 * is NOT_FOUND; the system (`viewer` null) sees everything.
 */
export async function lockedRelocation(env: ActionEnv, viewer: Viewer | null, relocationId: string): Promise<{ row: RelocationRow; account: AccountRow }> {
  const unlocked = await findRelocation(env.tx, viewer, relocationId);
  const owner = await lockAccount(env.tx, viewer, unlocked.accountId);
  return { row: await findRelocation(env.tx, viewer, relocationId, true), account: owner };
}

/** A closed relocation takes no more steps. */
export function assertOpen(row: RelocationRow): void {
  if (!isOpen(row.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This relocation is ${row.status}` });
}

/** What an open relocation's step does, decided from the locked row. */
interface RelocationPlan {
  /** The status after the step (the same when the step leaves it). */
  to: RelocationStatus;
  reason: string;
  payload?: Record<string, unknown>;
  /** The relocation's other columns that change with the step. */
  set: Partial<typeof relocation.$inferInsert>;
  /** The audit entry, built from the updated row. */
  audit(updated: RelocationRow): AuditNote;
}

/**
 * A step on an open relocation that is logged in `relocation_event` and replays by its id:
 * lock, replay a repeat, refuse a closed relocation, then write in one fixed order: the log
 * row first (a trigger refuses a status change without it), the relocation, the audit entry.
 */
export async function openRelocationStep(
  env: ActionEnv,
  viewer: Viewer | null,
  req: { id?: string | undefined; relocationId: string },
  step: { kind: RelocationEventKind; fingerprint: string; plan(before: RelocationRow): RelocationPlan },
) {
  const { row } = await lockedRelocation(env, viewer, req.relocationId);
  return relocationLog.once(
    env,
    req.id,
    { parentId: row.id, kind: step.kind, fingerprint: step.fingerprint },
    {
      replay: () => ({ relocation: toRelocationDto(row) }),
      run: async () => {
        assertOpen(row);
        const plan = step.plan(row);
        await relocationLog.append(env, row.id, {
          id: req.id,
          kind: step.kind,
          fromStatus: row.status,
          toStatus: plan.to,
          reason: plan.reason,
          payload: plan.payload,
          fingerprint: step.fingerprint,
        });
        const [updated] = await env.tx
          .update(relocation)
          .set({ ...plan.set, status: plan.to, updatedAt: new Date() })
          .where(eq(relocation.id, row.id))
          .returning();
        await env.audit(plan.audit(updated!));
        return { relocation: toRelocationDto(updated!) };
      },
    },
  );
}
