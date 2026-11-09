import { enqueueEvent, recordAudit, type AuditSource, type Transaction } from "@flowless/db";
import type { AuditNote } from "../trpc";
import type { EventDef } from "./events";

/*
 * What a use case needs from whoever calls it: a tenant transaction, the organization, who
 * acts, and the two things every change does in that transaction, `audit` and `publish`.
 * Procedures, consumers and jobs all build one (`procedureEnv` or `systemEnv`), so a use case
 * is written once and runs from any of them. Modules import it from here, never from each other.
 */

/** The env of a use case that may run as the system (an approval's outcome, an automatic step). */
export interface ActionEnv {
  tx: Transaction;
  organizationId: string;
  /** Null for the system. */
  actor: { userId: string | null };
  source: AuditSource;
  audit(note: AuditNote): Promise<void>;
  publish<T>(event: EventDef<T>, payload: T): Promise<unknown>;
}

/** The env of a use case that needs a person (it records who created or opened something). Only `procedureEnv` builds one. */
export interface UserActionEnv extends ActionEnv {
  actor: { userId: string };
}

/** The env for a procedure's context: the signed-in person acts. */
export function procedureEnv(ctx: {
  tx: Transaction;
  organizationId: string;
  session: { user: { id: string } };
  source?: AuditSource | undefined;
  audit(note: AuditNote): Promise<void>;
  publish<T>(event: EventDef<T>, payload: T): Promise<unknown>;
}): UserActionEnv {
  return {
    tx: ctx.tx,
    organizationId: ctx.organizationId,
    actor: { userId: ctx.session.user.id },
    source: ctx.source ?? "api",
    audit: (note) => ctx.audit(note),
    publish: (event, payload) => ctx.publish(event, payload),
  };
}

/** The env for work the system does on its own, inside a tenant transaction. */
export function systemEnv(tx: Transaction, organizationId: string): ActionEnv {
  return {
    tx,
    organizationId,
    actor: { userId: null },
    source: "system",
    audit: (note) => recordAudit(tx, { ...note, organizationId, source: "system", actorUserId: null, actorLabel: "System" }),
    publish: (event, payload) =>
      enqueueEvent(tx, { organizationId, type: event.type, version: event.version, payload: event.schema.parse(payload) }),
  };
}
