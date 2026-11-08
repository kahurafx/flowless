import { approvalDecision, approvalRequest, enqueueEvent, withTenant, type Database, type Transaction } from "@flowless/db";
import { isPermission, type ApprovalStatus, type ModuleKey, type Permission } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { readSetting, type SettingDef } from "./config-store";
import { defineConsumer, defineEvent, type Consumer, type ConsumerContext } from "./events";
import { raiseException, resolveByDedupeKey } from "./exception-store";
import { isUniqueViolation } from "./pg-errors";

const permission = z.string().refine(isPermission, "Unknown permission") as unknown as z.ZodType<Permission>;
const reasonCode = z.object({
  code: z.string().regex(/^[A-Z0-9_]{2,32}$/, "Reason codes are 2–32 capital letters, digits or _"),
  label: z.string().trim().min(1).max(80),
});

/**
 * An organization's policy for one approval kind (K-05), kept in the configuration store
 * (K-10). Levels decide in order; a level with `minAmount` (minor units, as digits) only
 * applies to requests of at least that amount, so small requests skip it, and a request no
 * level applies to is approved at once. Past `slaHours` at a level, the request is
 * escalated: it shows in the exception queue and holders of `escalateTo` may decide it too.
 */
export const approvalPolicySchema = z.object({
  levels: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(80),
        permission,
        minAmount: z.string().regex(/^\d+$/, "Amounts are whole minor units").optional(),
      }),
    )
    .max(5),
  slaHours: z.number().int().min(1).max(720).default(48),
  escalateTo: permission.optional(),
  /** Replaces the kind's default reason codes when set. */
  reasonCodes: z.array(reasonCode).max(50).optional(),
});
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

export interface ApprovalDef {
  /** "<module>.<what>", unique, e.g. "collections.rebate". */
  readonly key: string;
  readonly module: ModuleKey | "kernel";
  readonly label: string;
  readonly description: string;
  /** Default reason codes; a request must carry one when the list is not empty. */
  readonly reasonCodes: readonly { code: string; label: string }[];
  readonly policy: ApprovalPolicy;
}

export function defineApproval(def: ApprovalDef): ApprovalDef {
  return def;
}

const policySettings = new Map<string, SettingDef<ApprovalPolicy>>();

/** The configuration-store setting holding an organization's policy for `def`. */
export function approvalPolicySetting(def: ApprovalDef): SettingDef<ApprovalPolicy> {
  let setting = policySettings.get(def.key);
  if (!setting) {
    setting = {
      key: `approvals.${def.key}`,
      module: def.module,
      label: `Approval: ${def.label}`,
      description: def.description,
      schema: approvalPolicySchema as z.ZodType<ApprovalPolicy>,
      default: def.policy,
    };
    policySettings.set(def.key, setting);
  }
  return setting;
}

/** What a request remembers of the policy: the levels that apply to it. */
export interface PolicySnapshot {
  levels: { label: string; permission: Permission }[];
  slaHours: number;
  escalateTo: Permission | null;
}

export const approvalDecided = defineEvent(
  "approval.decided",
  z.object({
    requestId: z.uuid(),
    kind: z.string(),
    subjectRef: z.string(),
    outcome: z.enum(["approved", "rejected", "cancelled"]),
    /** Minor units as digits, or null. */
    amount: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
  }),
);
export type ApprovalDecided = z.infer<typeof approvalDecided.schema>;

/** A consumer for the outcomes of one approval kind: the requesting module applies them. */
export function defineApprovalConsumer(
  def: ApprovalDef,
  name: string,
  handle: (ctx: ConsumerContext, decided: ApprovalDecided) => Promise<void>,
): Consumer<ApprovalDecided> {
  return defineConsumer({
    name,
    module: def.module,
    event: approvalDecided,
    async handle(ctx, decided) {
      if (decided.kind === def.key) await handle(ctx, decided);
    },
  });
}

const dueAt = (hours: number) => new Date(Date.now() + hours * 3_600_000);
const overdueKey = (id: string) => `approval:${id}`;

type RequestRow = typeof approvalRequest.$inferSelect;

async function publishOutcome(tx: Transaction, row: RequestRow, outcome: ApprovalDecided["outcome"]) {
  await enqueueEvent(tx, {
    organizationId: row.organizationId,
    type: approvalDecided.type,
    version: approvalDecided.version,
    payload: approvalDecided.schema.parse({
      requestId: row.id,
      kind: row.kind,
      subjectRef: row.subjectRef,
      outcome,
      amount: row.amount === null ? null : row.amount.toString(),
      payload: row.payload as Record<string, unknown>,
    }),
  });
}

export interface RequestApproval {
  subjectRef: string;
  title: string;
  amount?: bigint | null;
  reasonCode?: string | null;
  note?: string;
  payload?: Record<string, unknown>;
  areaId?: string | null;
  routeId?: string | null;
  requestedByUserId: string;
}

/**
 * Asks for an approval inside the requesting module's transaction, under the
 * organization's current policy for `def`. Returns `approved` at once when no level
 * applies (the outcome event is still published). One pending request per subject.
 */
export async function requestApproval(
  tx: Transaction,
  organizationId: string,
  def: ApprovalDef,
  input: RequestApproval,
): Promise<{ id: string; status: ApprovalStatus }> {
  const policy = (await readSetting(tx, approvalPolicySetting(def))).value;
  const codes = policy.reasonCodes ?? def.reasonCodes;
  if (codes.length && !codes.some((c) => c.code === input.reasonCode)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a reason" });
  }
  const amount = input.amount ?? null;
  const levels = policy.levels
    .filter((l) => !l.minAmount || (amount !== null && amount >= BigInt(l.minAmount)))
    .map(({ label, permission }) => ({ label, permission }));
  const snapshot: PolicySnapshot = { levels, slaHours: policy.slaHours, escalateTo: policy.escalateTo ?? null };
  const decided = levels.length === 0;

  let row: RequestRow | undefined;
  try {
    [row] = await tx
      .insert(approvalRequest)
      .values({
        organizationId,
        kind: def.key,
        subjectRef: input.subjectRef,
        title: input.title,
        amount,
        reasonCode: input.reasonCode ?? null,
        note: input.note ?? "",
        payload: input.payload ?? {},
        policy: snapshot,
        status: decided ? "approved" : "pending",
        dueAt: decided ? null : dueAt(snapshot.slaHours),
        decidedAt: decided ? new Date() : null,
        areaId: input.areaId ?? null,
        routeId: input.routeId ?? null,
        requestedByUserId: input.requestedByUserId,
      })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: "This is already waiting for approval" });
    throw error;
  }
  if (decided) await publishOutcome(tx, row!, "approved");
  return { id: row!.id, status: row!.status };
}

export interface Actor {
  userId: string;
  permissions: ReadonlySet<Permission>;
}

/** Why `actor` may not decide `row` now, or null if they may. */
export function decideProblem(row: RequestRow, actor: Actor, approvedBy: readonly string[]): string | null {
  if (row.status !== "pending") return "This request is already decided";
  if (row.requestedByUserId === actor.userId) return "You can't decide your own request";
  if (approvedBy.includes(actor.userId)) return "You already approved an earlier level of this request";
  const policy = row.policy as PolicySnapshot;
  const level = policy.levels[row.level];
  if (!level) return "This request has no level left to decide";
  if (actor.permissions.has(level.permission)) return null;
  if (row.escalatedAt && policy.escalateTo && actor.permissions.has(policy.escalateTo)) return null;
  return `Needs ${level.permission}`;
}

export async function approversOf(tx: Transaction, requestId: string): Promise<string[]> {
  const rows = await tx
    .select({ by: approvalDecision.byUserId })
    .from(approvalDecision)
    .where(and(eq(approvalDecision.requestId, requestId), eq(approvalDecision.decision, "approve")));
  return rows.map((r) => r.by);
}

/**
 * Records a decision on the current level and moves the request on: the next level
 * (fresh SLA), or the final outcome, published as `approval.decided`. Any overdue
 * exception for the level just decided is resolved.
 */
export async function decide(
  tx: Transaction,
  row: RequestRow,
  actor: Actor,
  decision: "approve" | "reject",
  note: string | null,
): Promise<{ status: ApprovalStatus; level: number }> {
  const problem = decideProblem(row, actor, await approversOf(tx, row.id));
  if (problem) throw new TRPCError({ code: row.status === "pending" ? "FORBIDDEN" : "PRECONDITION_FAILED", message: problem });

  const policy = row.policy as PolicySnapshot;
  await tx.insert(approvalDecision).values({
    organizationId: row.organizationId,
    requestId: row.id,
    level: row.level,
    decision,
    byUserId: actor.userId,
    note,
  });
  const last = row.level + 1 >= policy.levels.length;
  const next =
    decision === "reject" || last
      ? { status: decision === "reject" ? ("rejected" as const) : ("approved" as const), level: row.level, dueAt: null, decidedAt: new Date() }
      : { status: "pending" as const, level: row.level + 1, dueAt: dueAt(policy.slaHours), decidedAt: null };

  // Guarded on the level the decider saw, so two people deciding at once cannot both win.
  const [updated] = await tx
    .update(approvalRequest)
    .set({ ...next, escalatedAt: null })
    .where(and(eq(approvalRequest.id, row.id), eq(approvalRequest.status, "pending"), eq(approvalRequest.level, row.level)))
    .returning();
  if (!updated) throw new TRPCError({ code: "CONFLICT", message: "Someone decided this request at the same time. Reload and try again." });

  await resolveByDedupeKey(tx, overdueKey(row.id), next.status === "pending" ? "Moved to the next level" : `Request ${next.status}`);
  if (next.status !== "pending") await publishOutcome(tx, updated, next.status);
  return { status: next.status, level: next.level };
}

/** Withdraws a pending request. */
export async function cancel(tx: Transaction, row: RequestRow, byUserId: string, note: string | null) {
  if (row.status !== "pending") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This request is already decided" });
  await tx.insert(approvalDecision).values({
    organizationId: row.organizationId,
    requestId: row.id,
    level: row.level,
    decision: "cancel",
    byUserId,
    note,
  });
  const [updated] = await tx
    .update(approvalRequest)
    .set({ status: "cancelled", dueAt: null, decidedAt: new Date() })
    .where(and(eq(approvalRequest.id, row.id), eq(approvalRequest.status, "pending")))
    .returning();
  if (!updated) throw new TRPCError({ code: "CONFLICT", message: "This request was decided meanwhile" });
  await resolveByDedupeKey(tx, overdueKey(row.id), "Request cancelled");
  await publishOutcome(tx, updated, "cancelled");
}

/**
 * Escalates requests past their SLA (K-05): marks them and raises APPROVAL_OVERDUE in the
 * exception queue, unassigned, placed in the request's area or route. Run by the worker.
 */
export async function escalateApprovals(db: Database, { batch = 50 }: { batch?: number } = {}): Promise<number> {
  const due = await db.execute<{ id: string; organization_id: string }>(sql`select * from kernel.overdue_approvals(${batch})`);
  let escalated = 0;
  for (const { id, organization_id: organizationId } of due) {
    await withTenant(db, organizationId, async (tx) => {
      const [row] = await tx
        .update(approvalRequest)
        .set({ escalatedAt: new Date() })
        .where(and(eq(approvalRequest.id, id), eq(approvalRequest.status, "pending"), sql`${approvalRequest.escalatedAt} is null`))
        .returning();
      if (!row) return;
      const policy = row.policy as PolicySnapshot;
      const level = policy.levels[row.level];
      await raiseException(tx, organizationId, {
        type: "APPROVAL_OVERDUE",
        source: "kernel",
        title: `Approval overdue: ${row.title}`,
        detail: `Waiting at ${level?.label ?? "a level"} for more than ${policy.slaHours} hours.${
          policy.escalateTo ? ` Members with ${policy.escalateTo} may now decide it.` : ""
        }`,
        subject: { kind: "approval", ref: row.id },
        areaId: row.areaId,
        routeId: row.routeId,
        dedupeKey: overdueKey(row.id),
      });
      escalated += 1;
    });
  }
  return escalated;
}
