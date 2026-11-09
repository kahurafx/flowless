import { account, accountCommand } from "@flowless/db/schema/accounts";
import type { AccountCommandKind } from "@flowless/shared-types";
import { eq } from "drizzle-orm";
import type { CommandEnv, CommandRow } from "./commands";
import { claimingId } from "./idempotent";
import type { AccountRow } from "./service";

/*
 * Changes to an account that move no status (succession C-08, relocation C-09, change of
 * name C-10) still get a place in the account's command log: a `succeed`, `relocate` or
 * `change_name` row with from-state = to-state. That gives them what status commands have: a
 * client-mintable id (a retry returns the earlier result, a different request under the id is
 * CONFLICT, both through `commandLog.once` in `commands.ts`), an actor and a reason, and a row in `commands.list`. The use case then audits
 * and publishes itself.
 */

export type ChangeKind = Extract<AccountCommandKind, "succeed" | "change_name" | "relocate">;

/** Writes the log row for a change that leaves the account's status as it is (state read from `row`). */
export async function logChange(
  env: CommandEnv,
  row: Pick<AccountRow, "id" | "commercialStatus" | "serviceStatus" | "serviceStatusReason">,
  change: { id?: string | undefined; kind: ChangeKind; reason: string; note?: string | undefined; payload: Record<string, unknown>; fingerprint: string },
): Promise<CommandRow> {
  const [command] = await claimingId(() =>
    env.tx
      .insert(accountCommand)
      .values({
        ...(change.id ? { id: change.id } : {}),
        organizationId: env.organizationId,
        accountId: row.id,
        kind: change.kind,
        fromCommercialStatus: row.commercialStatus,
        toCommercialStatus: row.commercialStatus,
        fromServiceStatus: row.serviceStatus,
        toServiceStatus: row.serviceStatus,
        serviceReason: row.serviceStatusReason,
        reason: change.reason.trim(),
        actorUserId: env.actor.userId,
        source: env.source,
        note: change.note ?? null,
        payload: change.payload,
        fingerprint: change.fingerprint,
      })
      .returning(),
  );
  return command!;
}

/** The account's current row (after earlier steps of the same use case changed it). */
export async function reload(env: CommandEnv, id: string): Promise<AccountRow> {
  const [row] = await env.tx.select().from(account).where(eq(account.id, id));
  return row!;
}

