import { account } from "@flowless/db/schema/accounts";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { readSetting } from "../../kernel/config-store";
import { router } from "../../trpc";
import type { Viewer } from "./access";
import { writeOffApproval } from "./approvals";
import { activationStatus, setCheck } from "./activation";
import { procedureEnv } from "../../kernel/action-env";
import { recheckActivation } from "./auto-activation";
import { listCommands } from "./command-log";
import { runCommand, type CommandRequest } from "./commands";
import type { AccountsProcedures } from "./procedures";
import { findAccount, firstPlacement } from "./service";
import { statusRulesSetting } from "./settings";
import { positionOf } from "./sources";
import { statusRuleTable } from "./status-rules";

/**
 * The account lifecycle's procedures (C-03, C-04, C-06, C-11), merged into the Accounts router
 * at its root. Every status command takes an optional client-minted `id`: repeating it with
 * the same request returns the earlier result, with a different one it is CONFLICT. All of
 * them need `accounts:change_status` (the `status` procedure); reads need `accounts:read`.
 */

const accountId = z.uuid();
const commandBase = {
  /** Client-minted, so a retry returns the first result. */
  id: z.uuid().optional(),
  accountId,
  reason: z.string().trim().min(1, "Say why").max(500),
  reasonCode: z.string().trim().min(1).max(40).optional(),
  note: z.string().trim().max(2000).optional(),
};

const activateInput = z.object({
  ...commandBase,
  /** Leave the service DISCONNECTED after activation; `serviceReason` then says why. */
  connect: z.boolean().optional(),
  serviceReason: z.string().trim().min(1).max(500).optional(),
  /** Activate although required gates are unmet: needs `settings:manage`, and is recorded. */
  override: z.boolean().optional(),
});

export function lifecycleProcedureSet(p: AccountsProcedures) {
  type Ctx = Parameters<typeof procedureEnv>[0] & { viewer: Viewer; permissions: ReadonlySet<string> };

  const run = (ctx: Ctx, request: CommandRequest) => runCommand(procedureEnv(ctx), ctx.viewer, request);

  const activate = p.status.input(activateInput).mutation(({ ctx, input }) => {
    if (input.override && !ctx.permissions.has("settings:manage")) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Activating past unmet gates needs settings:manage" });
    }
    return run(ctx, { ...input, kind: "activate" });
  });

  const simple = (kind: "mark_pending_payment" | "make_dormant" | "reactivate" | "disconnect_service" | "reconnect_service") =>
    p.status.input(z.object(commandBase)).mutation(({ ctx, input }) => run(ctx, { ...input, kind }));

  return {
    /** NEW to PENDING_PAYMENT: the new-connection invoice is out and payment is awaited. */
    markPendingPayment: simple("mark_pending_payment"),
    /**
     * Runs the activation gates and activates (NEW or PENDING_PAYMENT to ACTIVE, service
     * CONNECTED unless `connect: false`). Unmet required gates are PRECONDITION_FAILED naming
     * them; `override: true` activates anyway for a holder of `settings:manage`.
     */
    activate,
    makeDormant: simple("make_dormant"),
    reactivate: simple("reactivate"),
    /**
     * Terminates the account (terminal). With a ledger registered it needs a final bill and a
     * zero balance, or the approved write-off (`approvalId`) covering the balance; with none,
     * `acknowledgeNoLedger: true`.
     */
    terminate: p.status
      .input(z.object({ ...commandBase, approvalId: z.uuid().optional(), acknowledgeNoLedger: z.boolean().optional() }))
      .mutation(({ ctx, input }) => run(ctx, { ...input, kind: "terminate" })),
    disconnectService: simple("disconnect_service"),
    reconnectService: simple("reconnect_service"),

    /** Asks for approval (K-05) to write off the balance owing, so the account can be terminated. */
    requestWriteOff: p.status
      .input(
        z.object({
          accountId,
          /** The balance to write off, in minor units. */
          amount: z.bigint().positive(),
          reasonCode: z.string().refine((c) => writeOffApproval.reasonCodes.some((r) => r.code === c), "Choose a reason"),
          note: z.string().trim().min(1, "Say why").max(2000),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const row = await findAccount(ctx.tx, ctx.viewer, { id: input.accountId });
        if (row.commercialStatus === "TERMINATED") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This account is already terminated" });
        const position = await positionOf(ctx.tx, ctx.organizationId, row.id);
        if (position && position.balance <= 0n) throw new TRPCError({ code: "BAD_REQUEST", message: "There is no balance owing to write off" });
        if (position && input.amount < position.balance) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "The write-off must cover the whole balance owing" });
        }
        const where = await firstPlacement(ctx.tx, row.id);
        const request = await ctx.requestApproval(writeOffApproval, {
          subjectRef: row.id,
          title: `Write off ${row.number}`,
          amount: input.amount,
          reasonCode: input.reasonCode,
          note: input.note,
          payload: { accountId: row.id, number: row.number },
          areaId: where.areaId,
          routeId: where.routeId,
        });
        return { approvalId: request.id, status: request.status };
      }),

    commands: router({
      /** The account's status commands, newest first. */
      list: p.read
        .input(z.object({ accountId, limit: z.number().int().min(1).max(200).default(50), before: z.date().optional() }))
        .query(({ ctx, input }) => listCommands(ctx.tx, ctx.viewer, input.accountId, input)),
    }),

    /** The status-by-charge table in force at a date (default now), with its version (C-04). */
    statusRules: p.read.input(z.object({ at: z.date().optional() }).optional()).query(async ({ ctx, input }) => {
      const found = await readSetting(ctx.tx, statusRulesSetting, input?.at);
      return { rules: found.value, table: statusRuleTable(found.value), version: found.version, effectiveFrom: found.effectiveFrom };
    }),

    activation: router({
      /** The account's gates with their state and who decides each, and whether it is ready. */
      status: p.read.input(z.object({ accountId })).query(async ({ ctx, input }) => {
        const row = await findAccount(ctx.tx, ctx.viewer, { id: input.accountId });
        return activationStatus(ctx.tx, ctx.organizationId, row);
      }),
      tick: p.status
        .input(z.object({ accountId, gateKey: z.string().trim().min(1).max(40), note: z.string().trim().max(500).optional() }))
        .mutation(({ ctx, input }) => check(ctx, "tick", input)),
      untick: p.status
        .input(z.object({ accountId, gateKey: z.string().trim().min(1).max(40), note: z.string().trim().max(500).optional() }))
        .mutation(({ ctx, input }) => check(ctx, "untick", input)),
      /** The same as `accounts.activate`. */
      activate,
    }),
  };

  async function check(ctx: Ctx, action: "tick" | "untick", input: { accountId: string; gateKey: string; note?: string | undefined }) {
    const env = procedureEnv(ctx);
    const { account: row, changed, config } = await setCheck(env, ctx.viewer, { ...input, action });
    // In auto mode the last tick may complete the gates: activation then follows by itself.
    const auto = changed && action === "tick" && config.mode === "auto" ? await recheckActivation(ctx.tx, ctx.organizationId, row.id) : null;
    const [now] = await ctx.tx.select().from(account).where(eq(account.id, row.id));
    return { ...(await activationStatus(ctx.tx, ctx.organizationId, now!)), activated: auto?.activated ?? false };
  }
}
