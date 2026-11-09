import type { Transaction } from "@flowless/db";
import { activationCheck } from "@flowless/db/schema/accounts";
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { readSetting } from "../../kernel/config-store";
import type { Viewer } from "./access";
import { evaluateGates, gateList, hasPaymentGate, type ActivationConfig, type GateEvaluation } from "./gates";
import { findAccount, type AccountRow } from "./service";
import { activationSetting } from "./settings";
import { gatherFacts } from "./sources";
import type { UserActionEnv } from "../../kernel/action-env";

/*
 * Activation's reads and the office checklist (C-06). The decision itself is the pure
 * `evaluateGates` (`gates.ts`); here its inputs are gathered: the organization's setting, what
 * the registered gate sources say, and the checklist's newest rows.
 */

export interface TickState {
  ticked: boolean;
  byUserId: string;
  at: Date;
  note: string | null;
}

/** The checklist as it stands now: the newest row (highest seq) per gate; unticked gates are present with `ticked: false`. */
export async function currentChecks(tx: Transaction, accountId: string): Promise<Map<string, TickState>> {
  const rows = await tx
    .selectDistinctOn([activationCheck.gateKey], {
      gateKey: activationCheck.gateKey,
      action: activationCheck.action,
      byUserId: activationCheck.byUserId,
      at: activationCheck.at,
      note: activationCheck.note,
    })
    .from(activationCheck)
    .where(eq(activationCheck.accountId, accountId))
    .orderBy(activationCheck.gateKey, sql`${activationCheck.seq} desc`);
  return new Map(rows.map((r) => [r.gateKey, { ticked: r.action === "tick", byUserId: r.byUserId, at: r.at, note: r.note }]));
}

export type GateReport = GateEvaluation & {
  checks: Map<string, TickState>;
};

/** Where the account stands against its gates now. */
export async function gateReport(tx: Transaction, organizationId: string, accountId: string, config: ActivationConfig): Promise<GateReport> {
  const builtins = gateList(config).filter((g) => g.kind === "builtin" && g.enabled).map((g) => g.key);
  const [facts, checks] = await Promise.all([gatherFacts(tx, organizationId, accountId, builtins), currentChecks(tx, accountId)]);
  const ticked = Object.fromEntries([...checks].map(([key, state]) => [key, state.ticked]));
  return { ...evaluateGates(config, facts, ticked), checks };
}

/** Everything the activation screen needs. */
export async function activationStatus(tx: Transaction, organizationId: string, row: AccountRow) {
  const config = (await readSetting(tx, activationSetting)).value;
  const report = await gateReport(tx, organizationId, row.id, config);
  const open = row.commercialStatus === "NEW" || row.commercialStatus === "PENDING_PAYMENT";
  const paymentGate = hasPaymentGate(config);
  return {
    accountId: row.id,
    commercialStatus: row.commercialStatus,
    mode: config.mode,
    /** Activation can be asked for: the account is NEW or PENDING_PAYMENT (a NEW one goes via PENDING_PAYMENT when payment is a gate). */
    open,
    needsPendingPaymentFirst: open && row.commercialStatus === "NEW" && paymentGate,
    ready: report.ready,
    unmet: report.unmet,
    gates: report.gates.map((g) => {
      const tick = report.checks.get(g.key);
      return {
        ...g,
        ticked: tick?.ticked ?? false,
        tickedByUserId: tick?.ticked ? tick.byUserId : null,
        tickedAt: tick?.ticked ? tick.at : null,
        note: tick?.ticked ? tick.note : null,
      };
    }),
  };
}

/**
 * Ticks or unticks a gate on the office checklist. Insert-only: an untick is a retraction row.
 * Nothing is written when the gate already is as asked. Only a gate that is in use and that no
 * module decides for this account can be ticked by hand.
 */
export async function setCheck(
  env: UserActionEnv,
  viewer: Viewer,
  input: { accountId: string; gateKey: string; action: "tick" | "untick"; note?: string | undefined },
) {
  const { tx, organizationId } = env;
  const row = await findAccount(tx, viewer, { id: input.accountId }, true);
  if (row.commercialStatus !== "NEW" && row.commercialStatus !== "PENDING_PAYMENT") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The activation checklist applies to accounts that are new or pending payment" });
  }
  const config = (await readSetting(tx, activationSetting)).value;
  const gate = gateList(config).find((g) => g.key === input.gateKey);
  if (!gate) throw new TRPCError({ code: "BAD_REQUEST", message: "That is not one of this organization's activation gates" });
  if (!gate.enabled) throw new TRPCError({ code: "BAD_REQUEST", message: "That gate is not in use for this organization" });
  const report = await gateReport(tx, organizationId, row.id, config);
  const result = report.gates.find((g) => g.key === input.gateKey)!;
  if (result.via === "source") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `That gate is decided by the system${result.detail ? ` (${result.detail})` : ""}; it cannot be ticked by hand`,
    });
  }
  const was = report.checks.get(input.gateKey)?.ticked ?? false;
  const wants = input.action === "tick";
  if (was !== wants) {
    await tx.insert(activationCheck).values({
      organizationId,
      accountId: row.id,
      gateKey: input.gateKey,
      action: input.action,
      byUserId: env.actor.userId,
      note: input.note ?? null,
    });
    await env.audit({
      action: `accounts.activation_${input.action}`,
      subjectType: "account",
      subjectId: row.id,
      before: { gate: input.gateKey, ticked: was },
      after: { gate: input.gateKey, ticked: wants },
      reason: input.note ?? null,
    });
  }
  return { account: row, changed: was !== wants, config };
}
