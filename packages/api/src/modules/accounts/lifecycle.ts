import type { AccountCommandKind, CommercialStatus, ServiceState } from "@flowless/shared-types";

/*
 * The account state machine (C-03), pure: no I/O, no clock. It decides, for an account's
 * current state and a command, the state that results or why the command is refused.
 * `commands.ts` runs it under the account's row lock, writes the command row and updates the
 * account; nothing else may change a status (the database trigger enforces that too).
 *
 * Commercial status moves
 *   NEW -> PENDING_PAYMENT            mark_pending_payment
 *   NEW -> ACTIVE                     activate, only when the organization has no payment gate
 *   PENDING_PAYMENT -> ACTIVE         activate
 *   ACTIVE -> DORMANT                 make_dormant
 *   DORMANT -> ACTIVE                 reactivate
 *   NEW, PENDING_PAYMENT, ACTIVE, DORMANT -> TERMINATED   terminate (terminal)
 * The service axis (CONNECTED / DISCONNECTED, a reason when disconnected) moves with
 * disconnect_service and reconnect_service, and with activate and terminate. A NEW or
 * PENDING_PAYMENT account has no service yet, a TERMINATED one has none any more; a DORMANT
 * account keeps the service status it had, and may still be disconnected.
 */

export interface AccountState {
  commercial: CommercialStatus;
  service: ServiceState;
  /** Why the service is DISCONNECTED; null when CONNECTED. */
  serviceReason: string | null;
}

/** The commands that move an account's status (`write_off_decided` records an approval and moves nothing). */
export const STATUS_COMMANDS = [
  "activate",
  "mark_pending_payment",
  "make_dormant",
  "reactivate",
  "terminate",
  "disconnect_service",
  "reconnect_service",
] as const satisfies readonly AccountCommandKind[];
export type StatusCommand = (typeof STATUS_COMMANDS)[number];

const MOVES = {
  mark_pending_payment: { from: ["NEW"], to: "PENDING_PAYMENT" },
  activate: { from: ["NEW", "PENDING_PAYMENT"], to: "ACTIVE" },
  make_dormant: { from: ["ACTIVE"], to: "DORMANT" },
  reactivate: { from: ["DORMANT"], to: "ACTIVE" },
  terminate: { from: ["NEW", "PENDING_PAYMENT", "ACTIVE", "DORMANT"], to: "TERMINATED" },
  // Service commands leave the commercial status as it is.
  disconnect_service: { from: ["ACTIVE", "DORMANT"], to: null },
  reconnect_service: { from: ["ACTIVE"], to: null },
} as const satisfies Record<StatusCommand, { from: readonly CommercialStatus[]; to: CommercialStatus | null }>;

/** Where each command may start and end on the commercial axis (activate from NEW has a further condition). */
export const COMMERCIAL_MOVES: Record<StatusCommand, { from: readonly CommercialStatus[]; to: CommercialStatus | null }> = MOVES;

/** The commercial statuses command `K` may start from, as literals. */
export type Origin<K extends StatusCommand> = (typeof MOVES)[K]["from"][number];

export interface PlanContext {
  /** The organization requires payment before activation (the payment gate is enabled and required). */
  paymentGate: boolean;
  /** An authorised override of the gates: lets NEW activate directly even with a payment gate. */
  override: boolean;
}

export interface PlanInput {
  kind: StatusCommand;
  /** The command's reason, required and non-empty. */
  reason: string;
  /** activate: leave the service DISCONNECTED (with `serviceReason`) instead of connecting it. */
  connect?: boolean;
  serviceReason?: string;
}

export type Plan = { ok: true; to: AccountState } | { ok: false; problem: string };

/** The move a command makes, per kind: `from` is typed by what that kind allows, so nothing downstream casts it. */
export type Move = { [K in StatusCommand]: { kind: K; from: Origin<K>; to: AccountState } }[StatusCommand];
export type MoveOf<K extends StatusCommand> = Extract<Move, { kind: K }>;
export type StatusPlan = ({ ok: true } & Move) | { ok: false; problem: string };

const refuse = (problem: string): Plan => ({ ok: false, problem });
const words = (status: CommercialStatus) => status.toLowerCase().replace("_", " ");

/** Does the state satisfy the invariants of the two axes? */
export function stateIsValid(s: AccountState): boolean {
  if (s.service === "CONNECTED") return s.serviceReason === null && (s.commercial === "ACTIVE" || s.commercial === "DORMANT");
  return s.serviceReason !== null && s.serviceReason.trim().length > 0;
}

/**
 * The state `input` leads to from `state`, or why it cannot. Terminated is terminal: every
 * command is refused. A reason is required for every command.
 */
export function planCommand(state: AccountState, input: PlanInput, ctx: PlanContext): Plan {
  const reason = input.reason.trim();
  if (!reason) return refuse("Say why: every status change needs a reason");
  if (state.commercial === "TERMINATED") return refuse("This account is terminated, and a terminated account cannot change status");

  const move = COMMERCIAL_MOVES[input.kind];
  if (!move.from.includes(state.commercial)) {
    return refuse(`${actionName(input.kind)} is not possible while the account is ${words(state.commercial)}`);
  }

  switch (input.kind) {
    case "mark_pending_payment":
      return { ok: true, to: { commercial: "PENDING_PAYMENT", service: "DISCONNECTED", serviceReason: state.serviceReason ?? reason } };

    case "activate": {
      if (state.commercial === "NEW" && ctx.paymentGate && !ctx.override) {
        return refuse("This organization takes payment before activation: mark the account pending payment first");
      }
      const connect = input.connect ?? true;
      if (connect) return { ok: true, to: { commercial: "ACTIVE", service: "CONNECTED", serviceReason: null } };
      const why = input.serviceReason?.trim();
      if (!why) return refuse("Activating without connecting the service needs a reason for leaving it disconnected");
      return { ok: true, to: { commercial: "ACTIVE", service: "DISCONNECTED", serviceReason: why } };
    }

    case "make_dormant":
      return { ok: true, to: { ...state, commercial: "DORMANT" } };

    case "reactivate":
      return { ok: true, to: { ...state, commercial: "ACTIVE" } };

    case "terminate":
      return { ok: true, to: { commercial: "TERMINATED", service: "DISCONNECTED", serviceReason: `Account terminated: ${reason}` } };

    case "disconnect_service":
      if (state.service === "DISCONNECTED") return refuse("The service is already disconnected");
      return { ok: true, to: { ...state, service: "DISCONNECTED", serviceReason: reason } };

    case "reconnect_service":
      if (state.service === "CONNECTED") return refuse("The service is already connected");
      return { ok: true, to: { ...state, service: "CONNECTED", serviceReason: null } };
  }
}

/**
 * `planCommand`, with the move it makes: the kind and the commercial status it starts from,
 * narrowed to what that kind allows (`plan.kind === "terminate"` gives `plan.from` as one of
 * the four statuses termination starts from).
 */
export function planStatusCommand(state: AccountState, input: PlanInput, ctx: PlanContext): StatusPlan {
  const plan = planCommand(state, input, ctx);
  if (!plan.ok) return plan;
  // `planCommand` checked `state.commercial` against COMMERCIAL_MOVES[input.kind].from, which MOVES types per kind.
  return { ok: true, kind: input.kind, from: state.commercial, to: plan.to } as StatusPlan;
}

function actionName(kind: StatusCommand): string {
  return {
    mark_pending_payment: "Marking pending payment",
    activate: "Activation",
    make_dormant: "Making dormant",
    reactivate: "Reactivation",
    terminate: "Termination",
    disconnect_service: "Disconnecting the service",
    reconnect_service: "Reconnecting the service",
  }[kind];
}
