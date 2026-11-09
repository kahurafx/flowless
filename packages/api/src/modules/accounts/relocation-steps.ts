import { relocation, relocationEvent } from "@flowless/db/schema/accounts";
import type { RelocationEventKind, RelocationStatus } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { Viewer } from "./access";
import type { ActionEnv } from "../../kernel/action-env";
import { lockAccount } from "./commands";
import { claimingId, createdStep, loggedStep } from "./idempotent";
import { findRelocation, isOpen, toRelocationDto, type RelocationRow, type RelocationStepRow } from "./relocation-present";
import type { AccountRow } from "./service";

/*
 * The relocation's step log (table `relocation_event`) and the steps that share its shape
 * (C-09): a client-mintable id, a fingerprint, replay for the same request and CONFLICT for
 * any other (`idempotent.ts`), and a database trigger that refuses a status change without a row.
 */


/** The relocation step log's idempotency (replay for the same relocation, kind, actor and request). */
const relocationLog = loggedStep<RelocationStepRow>({
  find: async (tx, id) => (await tx.select().from(relocationEvent).where(eq(relocationEvent.id, id)))[0],
  parentOf: (e) => e.relocationId,
});

/** The idempotency of `request`: a repeat of the creator's own id replays. */
export const relocationCreation = createdStep<RelocationRow>({
  find: async (tx, id) => (await tx.select().from(relocation).where(eq(relocation.id, id)))[0],
  creatorOf: (r) => r.requestedByUserId,
});

/** One row of the relocation's step log. Not every kind moves the status: `work_recorded` rows (and a `survey_recorded` that leaves the status where it was) have from = to. */
export async function logStep(
  env: ActionEnv,
  relocationId: string,
  e: { id?: string | undefined; kind: RelocationEventKind; from: RelocationStatus | null; to: RelocationStatus; reason: string; payload?: Record<string, unknown>; fingerprint?: string | undefined },
) {
  const [row] = await claimingId(() =>
    env.tx
      .insert(relocationEvent)
      .values({
        ...(e.id ? { id: e.id } : {}),
        organizationId: env.organizationId,
        relocationId,
        kind: e.kind,
        fromStatus: e.from,
        toStatus: e.to,
        actorUserId: env.actor.userId,
        source: env.source,
        reason: e.reason.trim(),
        payload: e.payload ?? {},
        fingerprint: e.fingerprint ?? null,
      })
      .returning(),
  );
  return row!;
}

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

/**
 * A step on an open relocation that is logged in `relocation_event` and replays by its id:
 * lock, replay a repeat, refuse a closed relocation, then `apply` changes and audits it.
 */
export async function openRelocationStep(
  env: ActionEnv,
  viewer: Viewer | null,
  req: { id?: string | undefined; relocationId: string },
  step: { kind: RelocationEventKind; fingerprint: string; apply(row: RelocationRow): Promise<RelocationRow> },
) {
  const { row } = await lockedRelocation(env, viewer, req.relocationId);
  return relocationLog.once(
    env,
    req.id,
    { parentId: row.id, kind: step.kind, fingerprint: step.fingerprint },
    {
      replay: () => ({ relocation: toRelocationDto(row) }),
      run: async () => {
        if (!isOpen(row.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This relocation is ${row.status}` });
        return { relocation: toRelocationDto(await step.apply(row)) };
      },
    },
  );
}
