import type { Transaction } from "@flowless/db";
import type { Permission } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import type { BranchVerdict, WorkRegistry } from "../../../kernel/work";
import { MAIN } from "../common";

/** What a GIS procedure's context provides. */
export type GisCtx = {
  tx: Transaction;
  organizationId: string;
  session: { user: { id: string } };
  permissions: ReadonlySet<Permission>;
  work: WorkRegistry;
};

/**
 * May this caller write a PROPOSAL (create, edit, delete) to this branch? Main is the live
 * network, so writing to it straight away needs `gis:post` (a Flowless gap fix: Majimap let
 * field technicians edit main). A branch under a module's reserved prefix is that module's
 * call ("wo-" is Work Orders', "fld-" GIS's own personal branches); a reserved prefix
 * nobody guards ("field-") is refused. GIS never learns what the other module's rules are.
 */
export async function branchVerdict(ctx: GisCtx, branch: string): Promise<BranchVerdict> {
  if (branch === MAIN) {
    return ctx.permissions.has("gis:post")
      ? { allowed: true }
      : { allowed: false, reason: "Changing the live network needs gis:post: make the change on a job's branch or your own field branch" };
  }
  return ctx.work.checkBranchWrite(ctx.tx, { organizationId: ctx.organizationId, userId: ctx.session.user.id, permissions: ctx.permissions, branch });
}

export async function assertBranchWritable(ctx: GisCtx, branch: string): Promise<void> {
  const verdict = await branchVerdict(ctx, branch);
  if (!verdict.allowed) throw new TRPCError({ code: "FORBIDDEN", message: verdict.reason });
}

/**
 * The same question, answered yes or no. For logs: a log is a fact and is kept either way,
 * but the asset edit it would trigger is a proposal, so it only happens where a proposal
 * would be welcome.
 */
export async function branchAllowsWrite(ctx: GisCtx, branch: string): Promise<boolean> {
  return (await branchVerdict(ctx, branch)).allowed;
}
