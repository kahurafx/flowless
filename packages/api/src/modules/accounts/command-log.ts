import type { Transaction } from "@flowless/db";
import { accountCommand } from "@flowless/db/schema/accounts";
import { and, desc, eq, lt } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Viewer } from "./access";
import { defineStepLog } from "./idempotent";
import { findAccount } from "./service";

/*
 * The account's command log (C-03): the append-only descriptor every account step goes
 * through, the request fingerprint that decides what a retry is, and the log's reads.
 * `commands.ts` is the use case that changes a status; this is what it and the other account
 * steps (`succeed`, `change_name`, `relocate`) share.
 */

export type CommandRow = typeof accountCommand.$inferSelect;

/**
 * Idempotency of the account's command log: a command id replays for the same account, kind,
 * actor and request fingerprint, and is CONFLICT for anything else. Every account step
 * (status commands, `succeed`, `change_name`, `relocate`) goes through it.
 */
export const commandLog = defineStepLog(accountCommand, "accountId");

const stable = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );

/** A request as it must repeat to count as a retry: everything but the id. */
export function fingerprintOfRequest(req: Record<string, unknown>): string {
  const defined = Object.fromEntries(Object.entries(req).filter(([k, v]) => k !== "id" && v !== undefined));
  return createHash("sha256").update(stable(defined)).digest("hex");
}

export function toCommandDto(c: CommandRow) {
  return {
    id: c.id,
    accountId: c.accountId,
    kind: c.kind,
    fromCommercialStatus: c.fromCommercialStatus,
    toCommercialStatus: c.toCommercialStatus,
    fromServiceStatus: c.fromServiceStatus,
    toServiceStatus: c.toServiceStatus,
    serviceReason: c.serviceReason,
    reason: c.reason,
    reasonCode: c.reasonCode,
    actorUserId: c.actorUserId,
    source: c.source,
    occurredAt: c.occurredAt,
    note: c.note,
    payload: c.payload,
  };
}
export type CommandDto = ReturnType<typeof toCommandDto>;

/** The account's command log, newest first; a hidden account is NOT_FOUND. */
export async function listCommands(tx: Transaction, viewer: Viewer, accountId: string, opts: { limit: number; before?: Date | undefined }) {
  const row = await findAccount(tx, viewer, { id: accountId });
  const rows = await tx
    .select()
    .from(accountCommand)
    .where(and(eq(accountCommand.accountId, row.id), opts.before ? lt(accountCommand.occurredAt, opts.before) : undefined))
    .orderBy(desc(accountCommand.occurredAt), desc(accountCommand.id))
    .limit(opts.limit);
  return rows.map(toCommandDto);
}
