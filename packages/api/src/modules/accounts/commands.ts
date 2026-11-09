import { account } from "@flowless/db/schema/accounts";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { ActionEnv } from "../../kernel/action-env";
import { readSetting } from "../../kernel/config-store";
import type { Viewer } from "./access";
import { commandLog, fingerprintOfRequest, toCommandDto, type CommandDto } from "./command-log";
import { prepareActivate, prepareReactivate, prepareTerminate, type CommandFacts, type Prepared } from "./command-prepare";
import { accountStatusChanged, serviceStatusChanged } from "./events";
import { hasPaymentGate, type ActivationConfig } from "./gates";
import { planStatusCommand, type StatusCommand, type StatusPlan } from "./lifecycle";
import { lockAccount, presentAccount, type AccountDto, type AccountRow } from "./service";
import { activationSetting } from "./settings";

/*
 * The account lifecycle's use case (C-03, C-06, C-11): the only code that changes an
 * account's status. A command is planned by the pure state machine, checked by the unit of
 * its kind where it has one (`command-prepare.ts`), written to the append-only command log
 * (`command-log.ts`), applied to the account, audited and published, all in the caller's
 * transaction; the database trigger refuses a status change that skips the log.
 */

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

/** An account's status columns: the audit entry's before and after. */
const statusOf = (a: AccountRow) => ({ commercialStatus: a.commercialStatus, serviceStatus: a.serviceStatus, serviceStatusReason: a.serviceStatusReason });

/**
 * Runs one status command (C-03). `viewer` is the caller's scope (null for the system), so a
 * hidden account is NOT_FOUND. Everything happens under the account's row lock, so two
 * commands on one account take turns and each plans from the state the other left.
 *
 * Repeating a command id with the same request returns the earlier result; with a
 * different request, account or person it is CONFLICT.
 */
export async function runCommand(env: ActionEnv, viewer: Viewer | null, req: CommandRequest): Promise<CommandResult> {
  const row = await lockAccount(env.tx, viewer, req.accountId);
  const fingerprint = fingerprintOfRequest({ ...req });
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
async function applyCommand(env: ActionEnv, row: AccountRow, req: CommandRequest, fingerprint: string) {
  const config = (await readSetting(env.tx, activationSetting)).value;
  const plan = planStatusCommand(
    { commercial: row.commercialStatus, service: row.serviceStatus, serviceReason: row.serviceStatusReason },
    { kind: req.kind, reason: req.reason, connect: req.connect, serviceReason: req.serviceReason },
    // Only activation reads the override.
    { paymentGate: hasPaymentGate(config), override: req.override === true },
  );
  if (!plan.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: plan.problem });

  const { payload, events } = await prepare(env, row, req, plan, config);

  const to = plan.to;
  const command = await commandLog.append(env, row.id, {
    id: req.id,
    kind: req.kind,
    fromCommercialStatus: row.commercialStatus,
    toCommercialStatus: to.commercial,
    fromServiceStatus: row.serviceStatus,
    toServiceStatus: to.service,
    serviceReason: to.serviceReason,
    reason: req.reason,
    reasonCode: req.reasonCode,
    note: req.note,
    payload,
    fingerprint,
  });

  const [updated] = await env.tx
    .update(account)
    .set({ commercialStatus: to.commercial, serviceStatus: to.service, serviceStatusReason: to.serviceReason, statusCommandId: command.id })
    .where(eq(account.id, row.id))
    .returning();

  await env.audit({
    action: `accounts.${req.kind}`,
    subjectType: "account",
    subjectId: row.id,
    before: statusOf(row),
    after: { ...statusOf(updated!), commandId: command.id, ...payload },
    reason: req.reason.trim(),
  });

  const facts: CommandFacts = {
    accountId: updated!.id,
    number: updated!.number,
    commandId: command.id,
    reason: command.reason,
    actorUserId: command.actorUserId,
    occurredAt: command.occurredAt.toISOString(),
  };
  if (row.commercialStatus !== updated!.commercialStatus) {
    await env.publish(accountStatusChanged, { ...facts, kind: req.kind, from: row.commercialStatus, to: updated!.commercialStatus });
  }
  if (row.serviceStatus !== updated!.serviceStatus) {
    await env.publish(serviceStatusChanged, {
      ...facts,
      kind: req.kind,
      from: row.serviceStatus,
      to: updated!.serviceStatus,
      serviceReason: updated!.serviceStatusReason,
    });
  }
  for (const publish of events) await publish(env, facts);

  return { command: toCommandDto(command), account: await presentAccount(env.tx, updated!) };
}

/** The unit of the plan's kind; the kinds with nothing beyond the state change add nothing. */
async function prepare(
  env: ActionEnv,
  row: AccountRow,
  req: CommandRequest,
  plan: Exclude<StatusPlan, { ok: false }>,
  config: ActivationConfig,
): Promise<Prepared> {
  switch (plan.kind) {
    case "activate":
      return prepareActivate(env, row, plan, config, { override: req.override === true });
    case "reactivate":
      return prepareReactivate(plan);
    case "terminate":
      return prepareTerminate(env, row, plan, { approvalId: req.approvalId, acknowledgeNoLedger: req.acknowledgeNoLedger === true });
    default:
      return { payload: {}, events: [] };
  }
}
