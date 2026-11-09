import { enqueueEvent, recordAudit, type AuditSource, type Transaction } from "@flowless/db";
import { account, accountCommand } from "@flowless/db/schema/accounts";
import type { AccountCommandKind } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, lt } from "drizzle-orm";
import { createHash } from "node:crypto";
import { approvalOutcome } from "../../kernel/approval-store";
import { readSetting } from "../../kernel/config-store";
import { loadEntitlements } from "../../kernel/entitlement-store";
import type { EventDef } from "../../kernel/events";
import type { AuditNote } from "../../trpc";
import type { Viewer } from "./access";
import { gateReport } from "./activation";
import { accountActivated, accountStatusChanged, accountTerminated, serviceStatusChanged } from "./events";
import { hasPaymentGate } from "./gates";
import { planCommand, type StatusCommand } from "./lifecycle";
import { claimingId, loggedStep } from "./idempotent";
import { notFound } from "../../kernel/errors";
import { findAccount, presentAccount, type AccountDto, type AccountRow } from "./service";
import { activationSetting } from "./settings";
import { positionOf } from "./sources";
import { settleTermination } from "./termination";

/*
 * The account lifecycle's use cases (C-03, C-06, C-11): the only code that changes an
 * account's status. A command is planned by the pure state machine, written to the
 * append-only command log, applied to the account, audited and published, all in the
 * caller's transaction; the database trigger refuses a status change that skips the log.
 */

/** What a command needs from its caller; `procedureEnv` and `systemEnv` build it. */
export interface CommandEnv {
  tx: Transaction;
  organizationId: string;
  /** Null for the system (automatic activation, an approval's outcome). */
  actor: { userId: string | null };
  source: AuditSource;
  audit(note: AuditNote): Promise<void>;
  publish<T>(event: EventDef<T>, payload: T): Promise<unknown>;
}

/** The env for a procedure's context. */
export function procedureEnv(ctx: {
  tx: Transaction;
  organizationId: string;
  session: { user: { id: string } };
  source?: AuditSource | undefined;
  audit(note: AuditNote): Promise<void>;
  publish<T>(event: EventDef<T>, payload: T): Promise<unknown>;
}): CommandEnv {
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
export function systemEnv(tx: Transaction, organizationId: string): CommandEnv {
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

export type CommandRow = typeof accountCommand.$inferSelect;

/**
 * Idempotency of the account's command log: a command id replays for the same account, kind,
 * actor and request fingerprint, and is CONFLICT for anything else. Every account step
 * (status commands, `succeed`, `change_name`, `relocate`) goes through it.
 */
export const commandLog = loggedStep<CommandRow>({
  find: async (tx, id) => (await tx.select().from(accountCommand).where(eq(accountCommand.id, id)))[0],
  parentOf: (c) => c.accountId,
  conflict: "That id was already used for a different request",
});

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
    payload: c.payload as Record<string, unknown>,
  };
}
export type CommandDto = ReturnType<typeof toCommandDto>;

export interface CommandRequest {
  /** Client-minted, so a retry returns the earlier result. */
  id?: string | undefined;
  accountId: string;
  kind: StatusCommand;
  reason: string;
  reasonCode?: string | undefined;
  note?: string | undefined;
  /** activate: leave the service disconnected, and why. */
  connect?: boolean | undefined;
  serviceReason?: string | undefined;
  /** activate: skip the gates. The caller must already have checked the right to (`settings:manage`). */
  override?: boolean | undefined;
  /** terminate: the approved write-off that covers the balance. */
  approvalId?: string | undefined;
  /** terminate: no ledger exists yet, and the caller confirms there is nothing owing. */
  acknowledgeNoLedger?: boolean | undefined;
}

export interface CommandResult {
  command: CommandDto;
  account: AccountDto;
  /** True when this id had already been used by the same request: nothing was done again. */
  replayed: boolean;
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );

/** A request as it must repeat to count as a retry: everything but the id. */
export function fingerprintOfRequest(req: Record<string, unknown>): string {
  const defined = Object.fromEntries(Object.entries(req).filter(([k, v]) => k !== "id" && v !== undefined));
  return createHash("sha256").update(stable(defined)).digest("hex");
}
const fingerprintOf = (req: CommandRequest): string => fingerprintOfRequest({ ...req });

const state = (a: AccountRow) => ({ commercial: a.commercialStatus, service: a.serviceStatus, serviceReason: a.serviceStatusReason });
const statusOf = (a: Pick<AccountRow, "commercialStatus" | "serviceStatus" | "serviceStatusReason">) => ({
  commercialStatus: a.commercialStatus,
  serviceStatus: a.serviceStatus,
  serviceStatusReason: a.serviceStatusReason,
});

export async function lockAccount(tx: Transaction, viewer: Viewer | null, accountId: string): Promise<AccountRow> {
  if (viewer) return findAccount(tx, viewer, { id: accountId }, true);
  const [row] = await tx.select().from(account).where(eq(account.id, accountId)).for("update");
  if (!row) throw notFound("Account");
  return row;
}

/**
 * Runs one status command (C-03). `viewer` is the caller's scope (null for the system), so a
 * hidden account is NOT_FOUND. Everything happens under the account's row lock, so two
 * commands on one account take turns and each plans from the state the other left.
 *
 * Repeating a command id with the same request returns the earlier result; with a
 * different request, account or person it is CONFLICT.
 */
export async function runCommand(env: CommandEnv, viewer: Viewer | null, req: CommandRequest): Promise<CommandResult> {
  const row = await lockAccount(env.tx, viewer, req.accountId);
  const fingerprint = fingerprintOf(req);
  return commandLog.once(
    env,
    req.id,
    { parentId: row.id, kind: req.kind, fingerprint },
    {
      replay: async (earlier) => ({ command: toCommandDto(earlier), account: await presentAccount(env.tx, row) }),
      run: () => applyCommand(env, row, req, fingerprint),
    },
  );
}

/** Plans and applies one command on the locked account: the effect `runCommand` runs once per id. */
async function applyCommand(env: CommandEnv, row: AccountRow, req: CommandRequest, fingerprint: string) {
  const { tx, organizationId } = env;
  const config = (await readSetting(tx, activationSetting)).value;
  const override = req.kind === "activate" && req.override === true;
  const plan = planCommand(
    state(row),
    { kind: req.kind, reason: req.reason, connect: req.connect, serviceReason: req.serviceReason },
    { paymentGate: hasPaymentGate(config), override },
  );
  if (!plan.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: plan.problem });

  const payload: Record<string, unknown> = {};
  let via: "checklist" | "auto" | "override" = env.source === "system" ? "auto" : "checklist";
  let settlement: ReturnType<typeof settleTermination> | null = null;

  if (req.kind === "activate") {
    const report = await gateReport(tx, organizationId, row.id, config);
    payload.gates = report.gates.map((g) => ({ key: g.key, state: g.state, via: g.via }));
    if (!report.ready) {
      const names = report.gates.filter((g) => report.unmet.includes(g.key)).map((g) => g.label);
      if (!override) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The account is not ready to activate. Unmet: ${names.join("; ")}` });
      }
      via = "override";
      payload.override = true;
      payload.overriddenGates = report.unmet;
    }
    payload.mode = config.mode;
    payload.via = via;
  }

  if (req.kind === "terminate") {
    const position = await positionOf(tx, organizationId, row.id);
    const writeOff = req.approvalId ? await approvalOutcome(tx, req.approvalId) : null;
    settlement = settleTermination({
      accountId: row.id,
      position,
      acknowledgeNoLedger: req.acknowledgeNoLedger === true,
      writeOff,
      writeOffCited: !!req.approvalId,
    });
    if (!settlement.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: settlement.problem });
    payload.basis = settlement.basis;
    payload.balance = settlement.balance === null ? null : settlement.balance.toString();
    payload.finalBillIssued = position?.finalBillIssued ?? null;
    if (req.approvalId) payload.writeOffApprovalId = req.approvalId;
    if (settlement.basis === "no_ledger") payload.acknowledgeNoLedger = true;
  }

  const to = plan.to;
  const commandId = req.id ?? undefined;
  const [command] = await claimingId(() =>
    tx
      .insert(accountCommand)
      .values({
        ...(commandId ? { id: commandId } : {}),
        organizationId,
        accountId: row.id,
        kind: req.kind,
        fromCommercialStatus: row.commercialStatus,
        toCommercialStatus: to.commercial,
        fromServiceStatus: row.serviceStatus,
        toServiceStatus: to.service,
        serviceReason: to.serviceReason,
        reason: req.reason.trim(),
        reasonCode: req.reasonCode ?? null,
        actorUserId: env.actor.userId,
        source: env.source,
        note: req.note ?? null,
        payload,
        fingerprint,
      })
      .returning(),
  );

  const [updated] = await tx
    .update(account)
    .set({ commercialStatus: to.commercial, serviceStatus: to.service, serviceStatusReason: to.serviceReason, statusCommandId: command!.id })
    .where(eq(account.id, row.id))
    .returning();

  await env.audit({
    action: `accounts.${req.kind}`,
    subjectType: "account",
    subjectId: row.id,
    before: statusOf(row),
    after: { ...statusOf(updated!), commandId: command!.id, ...payload },
    reason: req.reason.trim(),
  });
  await publishFor(env, row, updated!, command!, via, settlement && settlement.ok ? settlement : null, req.approvalId);

  return { command: toCommandDto(command!), account: await presentAccount(tx, updated!) };
}

async function publishFor(
  env: CommandEnv,
  before: AccountRow,
  after: AccountRow,
  command: CommandRow,
  via: "checklist" | "auto" | "override",
  settlement: { basis: "settled" | "written_off" | "no_ledger"; balance: bigint | null } | null,
  approvalId: string | undefined,
) {
  const facts = {
    accountId: after.id,
    number: after.number,
    commandId: command.id,
    reason: command.reason,
    actorUserId: command.actorUserId,
    occurredAt: command.occurredAt.toISOString(),
  };
  const kind: AccountCommandKind = command.kind;
  if (before.commercialStatus !== after.commercialStatus) {
    await env.publish(accountStatusChanged, { ...facts, kind, from: before.commercialStatus, to: after.commercialStatus });
  }
  if (before.serviceStatus !== after.serviceStatus) {
    await env.publish(serviceStatusChanged, {
      ...facts,
      kind,
      from: before.serviceStatus,
      to: after.serviceStatus,
      serviceReason: after.serviceStatusReason,
    });
  }
  if ((kind === "activate" || kind === "reactivate") && before.commercialStatus !== "TERMINATED") {
    await env.publish(accountActivated, {
      ...facts,
      from: before.commercialStatus as "NEW" | "PENDING_PAYMENT" | "DORMANT",
      via: kind === "reactivate" ? "reactivation" : via,
      service: after.serviceStatus,
    });
  }
  if (kind === "terminate" && settlement) {
    await env.publish(accountTerminated, {
      ...facts,
      from: before.commercialStatus as "NEW" | "PENDING_PAYMENT" | "ACTIVE" | "DORMANT",
      basis: settlement.basis,
      balance: settlement.balance === null ? null : settlement.balance.toString(),
      writeOffApprovalId: approvalId ?? null,
    });
  }
}

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

/**
 * Activates the account by itself when it is ready (C-06, mode `auto`). Other modules'
 * consumers call it, inside their event's tenant transaction, when a fact a gate depends on
 * changes (a payment confirmed, a meter installed, a reading captured). It activates only an
 * account that is NEW or PENDING_PAYMENT with every required gate met, never overrides, and
 * does nothing in checklist mode, when Accounts is unlicensed, or when the account is not
 * (yet) ready. A NEW account in an organization that takes payment first waits for
 * PENDING_PAYMENT.
 */
export async function recheckActivation(
  tx: Transaction,
  organizationId: string,
  accountId: string,
): Promise<{ activated: boolean; reason: string }> {
  if (!(await loadEntitlements(tx)).includes("accounts")) return { activated: false, reason: "Accounts is not licensed" };
  const config = (await readSetting(tx, activationSetting)).value;
  if (config.mode !== "auto") return { activated: false, reason: "Activation is by checklist" };
  const [row] = await tx.select().from(account).where(eq(account.id, accountId));
  if (!row) return { activated: false, reason: "No such account" };
  if (row.commercialStatus !== "NEW" && row.commercialStatus !== "PENDING_PAYMENT") {
    return { activated: false, reason: `The account is ${row.commercialStatus.toLowerCase().replace("_", " ")}` };
  }
  if (row.commercialStatus === "NEW" && hasPaymentGate(config)) return { activated: false, reason: "Waiting for the account to be marked pending payment" };
  try {
    await runCommand(systemEnv(tx, organizationId), null, { accountId, kind: "activate", reason: "All activation gates are met" });
    return { activated: true, reason: "All activation gates are met" };
  } catch (error) {
    // Not ready: runCommand refuses before it writes anything, so the caller's transaction is intact.
    if (error instanceof TRPCError && error.code === "PRECONDITION_FAILED") return { activated: false, reason: error.message };
    throw error;
  }
}
