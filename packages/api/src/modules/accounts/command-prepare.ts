import { TRPCError } from "@trpc/server";
import type { ActionEnv } from "../../kernel/action-env";
import { approvalOutcome } from "../../kernel/approval-store";
import type { EventDef } from "../../kernel/events";
import { gateReport } from "./activation";
import { accountActivated, accountTerminated } from "./events";
import type { ActivationConfig } from "./gates";
import type { MoveOf } from "./lifecycle";
import type { AccountRow } from "./service";
import { positionOf } from "./sources";
import { settleTermination } from "./termination";

/*
 * What the kinds of command that need more than a state change add to `runCommand`
 * (`commands.ts`, which stays generic): activate checks the gates, terminate the settlement,
 * and each says what goes into the command's payload and which domain event announces it.
 * A unit checks before anything is written (it throws PRECONDITION_FAILED), so a refused
 * command leaves nothing behind. The status-change events stay with `runCommand`.
 */

/** The facts every lifecycle event carries, known once the command row is written. */
export interface CommandFacts {
  accountId: string;
  number: string;
  commandId: string;
  reason: string;
  /** Null when the system acted. */
  actorUserId: string | null;
  occurredAt: string;
}

/** An event a unit has decided to publish, given the command's facts. */
export type PendingEvent = (env: ActionEnv, facts: CommandFacts) => Promise<unknown>;

export interface Prepared {
  /** Goes into the command row and, after the new status, into the audit entry. */
  payload: Record<string, unknown>;
  /** Published after the status-change events, in this order. */
  events: PendingEvent[];
}

const announce =
  <T>(event: EventDef<T>, payload: (facts: CommandFacts) => T): PendingEvent =>
  (env, facts) =>
    env.publish(event, payload(facts));

/** activate: every required gate met, or an authorised override that records which were not. */
export async function prepareActivate(
  env: ActionEnv,
  row: AccountRow,
  plan: MoveOf<"activate">,
  config: ActivationConfig,
  request: { override: boolean },
): Promise<Prepared> {
  const report = await gateReport(env.tx, env.organizationId, row.id, config);
  const gates = report.gates.map((g) => ({ key: g.key, state: g.state, via: g.via }));
  let via: "checklist" | "auto" | "override" = env.source === "system" ? "auto" : "checklist";
  const overridden: Record<string, unknown> = {};
  if (!report.ready) {
    const names = report.gates.filter((g) => report.unmet.includes(g.key)).map((g) => g.label);
    if (!request.override) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The account is not ready to activate. Unmet: ${names.join("; ")}` });
    }
    via = "override";
    overridden.override = true;
    overridden.overriddenGates = report.unmet;
  }
  return {
    payload: { gates, ...overridden, mode: config.mode, via },
    events: [announce(accountActivated, (facts) => ({ ...facts, from: plan.from, via, service: plan.to.service }))],
  };
}

/** reactivate: out of dormancy, with no gates to check. */
export function prepareReactivate(plan: MoveOf<"reactivate">): Prepared {
  return {
    payload: {},
    events: [announce(accountActivated, (facts) => ({ ...facts, from: plan.from, via: "reactivation" as const, service: plan.to.service }))],
  };
}

/** terminate: a settled position, an approved write-off that covers the balance, or the acknowledgement that no ledger exists. */
export async function prepareTerminate(
  env: ActionEnv,
  row: AccountRow,
  plan: MoveOf<"terminate">,
  request: { approvalId: string | undefined; acknowledgeNoLedger: boolean },
): Promise<Prepared> {
  const position = await positionOf(env.tx, env.organizationId, row.id);
  const writeOff = request.approvalId ? await approvalOutcome(env.tx, request.approvalId) : null;
  const settlement = settleTermination({
    accountId: row.id,
    position,
    acknowledgeNoLedger: request.acknowledgeNoLedger,
    writeOff,
    writeOffCited: !!request.approvalId,
  });
  if (!settlement.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: settlement.problem });
  const balance = settlement.balance === null ? null : settlement.balance.toString();
  return {
    payload: {
      basis: settlement.basis,
      balance,
      finalBillIssued: position?.finalBillIssued ?? null,
      ...(request.approvalId ? { writeOffApprovalId: request.approvalId } : {}),
      ...(settlement.basis === "no_ledger" ? { acknowledgeNoLedger: true } : {}),
    },
    events: [
      announce(accountTerminated, (facts) => ({
        ...facts,
        from: plan.from,
        basis: settlement.basis,
        balance,
        writeOffApprovalId: request.approvalId ?? null,
      })),
    ],
  };
}
