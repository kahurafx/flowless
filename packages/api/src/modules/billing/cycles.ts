import type { Transaction } from "@flowless/db";
import {
  CYCLE_FREQUENCIES,
  CYCLE_OUTCOMES,
  CYCLE_STATES,
  REVIEW_BASES,
  REVIEW_DECISIONS,
  cycle,
  cycleAccount,
  cycleEvent,
  cycleOutcome,
  cycleReview,
  document,
  type CycleOutcomeKind,
  type CycleState,
} from "@flowless/db/schema/billing";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { ActionEnv, UserActionEnv } from "../../kernel/action-env";
import { readSetting } from "../../kernel/config-store";
import { routesById } from "../../kernel/areas";
import { loadEntitlements } from "../../kernel/entitlement-store";
import { raiseException, resolveByDedupeKey } from "../../kernel/exception-store";
import { isUniqueViolation } from "../../kernel/pg-errors";
import { routeServicePointFacts } from "../accounts";
import { eligibilityOf, snapshotById, takeSnapshot } from "../metering";
import { completenessOf, incompleteMessage, type Completeness, type CompletenessRow } from "./completeness";
import { planClose, planMove } from "./cycle-machine";
import { cycleClosed, cycleOpened, cycleOutcomeRecorded, cycleStateChanged } from "./cycle-events";
import { reviewBucket, sampleSelection, type ReviewBucket, type ReviewThresholds } from "./cycle-review";
import { billingCycleSetting, billingReviewSetting } from "./cycle-settings";
import { enqueueCycleJobs } from "./cycle-enqueue";
import { lastDayOf } from "./period-lock";

/*
 * Billing cycles (B-01 to B-04, B-15, B-16). A cycle is one route and period. The state is
 * driven by the append-only `cycle_event` log (the database refuses any other change). On
 * open the cycle takes Metering's eligibility snapshot for the route and cycle date (the same
 * one the reading tasks use) and records every account on it; each expected account must end
 * with a terminal outcome (billed, billed_estimate, exception with its queue item, excluded
 * with a reason) before the cycle closes, and closing locks the period.
 *
 * Metering unlicensed: Billing does not depend on Metering, so the cycle falls back to
 * Accounts' published route facts (live service point, consumption billed by C-04) and takes
 * every such account as eligible, because there is no meter register to ask. `snapshot_id` is
 * null then. Advancing into `calculation` queues the per-account jobs (`cycle-enqueue.ts`, `bill-account.ts`).
 */

const Period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "A period is YYYY-MM");

export const openInputSchema = z.object({
  /** Minted by the client; the same id (or the same route and period) replays. */
  id: z.uuid().optional(),
  routeId: z.uuid(),
  period: Period,
  /** The cycle date the snapshot is for; defaults to the last day of the period. */
  cycleDate: z.iso.date().optional(),
  /** Defaults to the `billing.cycle` setting. */
  frequency: z.enum(CYCLE_FREQUENCIES).optional(),
});
export type OpenInput = z.infer<typeof openInputSchema>;

export const advanceInputSchema = z.object({
  /** Minted by the client; a repeat of the same event replays. */
  id: z.uuid().optional(),
  cycleId: z.uuid(),
  to: z.enum(CYCLE_STATES),
  reason: z.string().trim().max(1000).optional(),
});

export const closeInputSchema = z.object({ id: z.uuid().optional(), cycleId: z.uuid(), note: z.string().trim().max(1000).optional() });

export const outcomeInputSchema = z.object({
  id: z.uuid().optional(),
  cycleId: z.uuid(),
  accountId: z.uuid(),
  outcome: z.enum(CYCLE_OUTCOMES),
  reason: z.string().trim().max(1000).optional(),
  /** billed and billed_estimate: the invoice or credit note that bills the account. */
  documentId: z.uuid().optional(),
  /** Flags a bill for review (B-16). */
  flagged: z.boolean().default(false),
});

export const accountsInputSchema = z.object({
  cycleId: z.uuid(),
  /** `none`: expected accounts without an outcome yet. */
  outcome: z.enum([...CYCLE_OUTCOMES, "none"]).optional(),
  expected: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});

export const listInputSchema = z
  .object({ routeId: z.uuid().optional(), state: z.enum(CYCLE_STATES).optional(), period: Period.optional(), limit: z.number().int().min(1).max(200).default(50) })
  .default({ limit: 50 });

export const reviewInputSchema = z.object({
  cycleId: z.uuid(),
  accountId: z.uuid(),
  decision: z.enum(REVIEW_DECISIONS),
  basis: z.enum(REVIEW_BASES.filter((b) => b !== "bulk") as ["sample", "individual"]).default("individual"),
  reason: z.string().trim().max(1000).optional(),
});

type CycleRow = typeof cycle.$inferSelect;

export interface CycleDto {
  id: string;
  routeId: string;
  period: string;
  cycleDate: string;
  frequency: CycleRow["frequency"];
  trigger: CycleRow["trigger"];
  state: CycleState;
  snapshotId: string | null;
  openedByUserId: string | null;
  createdAt: Date;
}
const toDto = (c: CycleRow): CycleDto => ({
  id: c.id,
  routeId: c.routeId,
  period: c.period,
  cycleDate: c.cycleDate,
  frequency: c.frequency,
  trigger: c.trigger,
  state: c.state,
  snapshotId: c.snapshotId,
  openedByUserId: c.openedByUserId,
  createdAt: c.createdAt,
});

/** `lock`: true takes the row exclusively (moves, close); "share" lets many outcomes land at once while a close waits for them. */
export async function cycleRow(tx: Transaction, id: string, lock: boolean | "share" = false): Promise<CycleRow> {
  const query = tx.select().from(cycle).where(eq(cycle.id, id));
  const [row] = lock === "share" ? await query.for("share") : lock ? await query.for("update") : await query;
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Billing cycle not found" });
  return row;
}

/* ---------- open (B-02, B-03) ---------- */

export async function openCycle(env: UserActionEnv, input: OpenInput): Promise<{ cycle: CycleDto; replayed: boolean; accounts: number; expected: number }> {
  const { tx } = env;
  const counts = async (id: string) => {
    const [r] = await tx.execute<{ n: string; e: string }>(sql`select count(*)::text n, count(*) filter (where expected)::text e from billing.cycle_account where cycle_id = ${id}`);
    return { accounts: Number(r?.n ?? 0), expected: Number(r?.e ?? 0) };
  };
  const [byRoute] = await tx.select().from(cycle).where(and(eq(cycle.routeId, input.routeId), eq(cycle.period, input.period)));
  const [byId] = input.id ? await tx.select().from(cycle).where(eq(cycle.id, input.id)) : [];
  if (byId && (byId.routeId !== input.routeId || byId.period !== input.period)) throw new TRPCError({ code: "CONFLICT", message: "That id was used for a different cycle" });
  const existing = byId ?? byRoute;
  if (existing) {
    if (input.id && existing.id !== input.id) throw new TRPCError({ code: "CONFLICT", message: `Route already has a billing cycle for ${input.period}` });
    return { cycle: toDto(existing), replayed: true, ...(await counts(existing.id)) };
  }
  if (!(await routesById(tx, [input.routeId])).has(input.routeId)) throw new TRPCError({ code: "NOT_FOUND", message: "Route not found" });

  const settings = (await readSetting(tx, billingCycleSetting)).value;
  const cycleDate = input.cycleDate ?? lastDayOf(input.period);
  if (cycleDate < `${input.period}-01`) throw new TRPCError({ code: "BAD_REQUEST", message: "The cycle date cannot be before the period" });

  // B-03: one eligibility snapshot per route and cycle date, shared with the reading tasks.
  const licensed = (await loadEntitlements(tx)).includes("metering");
  let snapshotId: string | null = null;
  let rows: { accountId: string; servicePointId: string; eligible: boolean; reason: string }[];
  if (licensed) {
    const { snapshot } = await takeSnapshot(env, { routeId: input.routeId, cycleDate });
    snapshotId = snapshot.id;
    rows = snapshot.rows;
  } else {
    rows = (await routeServicePointFacts(tx, input.routeId)).map((f) => ({ accountId: f.accountId, servicePointId: f.servicePointId, ...eligibilityOf(f, true) }));
  }

  const id: string = input.id ?? crypto.randomUUID();
  const values: typeof cycle.$inferInsert = { id, organizationId: env.organizationId, period: input.period, cycleDate, frequency: input.frequency ?? settings.frequency, routeId: input.routeId, snapshotId, trigger: settings.trigger, openedByUserId: env.actor.userId };
  let row: CycleRow;
  try {
    [row] = (await tx
      .insert(cycle)
      .values(values)
      .returning()) as [CycleRow];
  } catch (error) {
    if (isUniqueViolation(error)) throw new TRPCError({ code: "CONFLICT", message: `Route already has a billing cycle for ${input.period} or on ${cycleDate}` });
    throw error;
  }
  await tx.insert(cycleEvent).values({ organizationId: env.organizationId, cycleId: id, seq: 1, fromState: null, toState: "open", kind: "open", actorUserId: env.actor.userId, source: env.source });

  // One row per account (an account with several service points is expected when any is eligible).
  const byAccount = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const had = byAccount.get(r.accountId);
    if (!had || (r.eligible && !had.eligible)) byAccount.set(r.accountId, r);
  }
  const accountRows = [...byAccount.values()].map((r) => ({ organizationId: env.organizationId, cycleId: id, accountId: r.accountId, servicePointId: r.servicePointId, expected: r.eligible, reason: r.reason }));
  if (accountRows.length) await tx.insert(cycleAccount).values(accountRows);
  const expected = accountRows.filter((a) => a.expected).length;

  await env.audit({ action: "billing.cycle_open", subjectType: "billing_cycle", subjectId: id, after: { routeId: input.routeId, period: input.period, cycleDate, snapshotId, accounts: accountRows.length, expected, metering: licensed } });
  await env.publish(cycleOpened, { cycleId: id, routeId: input.routeId, period: input.period, cycleDate, snapshotId, trigger: row.trigger, accounts: accountRows.length, expected });
  return { cycle: toDto(row), replayed: false, accounts: accountRows.length, expected };
}

/* ---------- state moves (B-02) ---------- */

async function logMove(env: ActionEnv, row: CycleRow, to: CycleState, kind: "advance" | "skip" | "retreat" | "close", eventId: string | undefined, reason: string | null) {
  const { tx } = env;
  const [last] = await tx.select({ seq: cycleEvent.seq }).from(cycleEvent).where(eq(cycleEvent.cycleId, row.id)).orderBy(desc(cycleEvent.seq)).limit(1);
  await tx.insert(cycleEvent).values({
    ...(eventId ? { id: eventId } : {}),
    organizationId: env.organizationId,
    cycleId: row.id,
    seq: (last?.seq ?? 0) + 1,
    fromState: row.state,
    toState: to,
    kind,
    reason,
    actorUserId: env.actor.userId,
    source: env.source,
  });
  await tx.update(cycle).set({ state: to }).where(eq(cycle.id, row.id));
  await env.audit({ action: kind === "close" ? "billing.cycle_close" : "billing.cycle_move", subjectType: "billing_cycle", subjectId: row.id, before: { state: row.state }, after: { state: to, kind, reason } });
  await env.publish(cycleStateChanged, { cycleId: row.id, routeId: row.routeId, period: row.period, from: row.state, to, kind, reason });
}

async function replayedEvent(tx: Transaction, eventId: string | undefined, cycleId: string, to: CycleState): Promise<boolean> {
  if (!eventId) return false;
  const [e] = await tx.select().from(cycleEvent).where(eq(cycleEvent.id, eventId));
  if (!e) return false;
  if (e.cycleId !== cycleId || e.toState !== to) throw new TRPCError({ code: "CONFLICT", message: "That id was used for a different cycle event" });
  return true;
}

export async function advanceCycle(env: ActionEnv, input: z.infer<typeof advanceInputSchema>): Promise<{ cycle: CycleDto; replayed: boolean; enqueued: number }> {
  const { tx } = env;
  const row = await cycleRow(tx, input.cycleId, true);
  if (await replayedEvent(tx, input.id, row.id, input.to)) return { cycle: toDto(row), replayed: true, enqueued: 0 };
  const plan = planMove(row.state, input.to, input.reason);
  if (!plan.ok) throw new TRPCError({ code: "BAD_REQUEST", message: plan.problem });
  // Leaving review forward needs every bill decided (B-16).
  if (row.state === "review" && plan.kind !== "retreat") {
    const pending = await pendingReview(tx, row.id);
    if (pending > 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${pending} bill${pending === 1 ? " is" : "s are"} not approved yet; approve or hold each (review) before issuing` });
  }
  await logMove(env, row, input.to, plan.kind, input.id, input.reason?.trim() || null);
  // B-07: the calculation state queues one job per expected account without an outcome; the estimation state queues the accounts whose visit found no dial (their disposition says how to bill them).
  const enqueued = input.to === "calculation" ? await enqueueCycleJobs(env, row.id, "pending") : input.to === "estimation" ? await enqueueCycleJobs(env, row.id, "missed") : null;
  return { cycle: toDto(await cycleRow(tx, row.id)), replayed: false, enqueued: enqueued?.enqueued ?? 0 };
}

export async function closeCycle(env: ActionEnv, input: z.infer<typeof closeInputSchema>): Promise<{ cycle: CycleDto; replayed: boolean; completeness: Completeness }> {
  const { tx } = env;
  const row = await cycleRow(tx, input.cycleId, true);
  if (await replayedEvent(tx, input.id, row.id, "closed")) return { cycle: toDto(row), replayed: true, completeness: await cycleCompleteness(tx, row.id) };
  const plan = planClose(row.state);
  if (!plan.ok) throw new TRPCError({ code: "BAD_REQUEST", message: plan.problem });
  const completeness = await cycleCompleteness(tx, row.id);
  if (!completeness.complete) throw new TRPCError({ code: "PRECONDITION_FAILED", message: incompleteMessage(completeness), cause: Object.assign(new Error("incomplete"), { completeness }) });
  await logMove(env, row, "closed", "close", input.id, input.note ?? null);
  const lockedThrough = lastDayOf(row.period);
  await env.publish(cycleClosed, { cycleId: row.id, routeId: row.routeId, period: row.period, lockedThrough, expected: completeness.expected });
  return { cycle: toDto(await cycleRow(tx, row.id)), replayed: false, completeness };
}

/* ---------- completeness (B-04) ---------- */

export async function completenessRows(tx: Transaction, cycleId: string): Promise<CompletenessRow[]> {
  const rows = await tx.execute<{ account_id: string; outcome: CycleOutcomeKind | null; reason: string | null; exception_id: string | null }>(sql`
    select a.account_id, o.outcome, o.reason, o.exception_id
      from billing.cycle_account a
      left join lateral (
        select x.outcome, x.reason, x.exception_id from billing.cycle_outcome x
         where x.organization_id = a.organization_id and x.cycle_id = a.cycle_id and x.account_id = a.account_id
         order by x.seq desc limit 1) o on true
     where a.cycle_id = ${cycleId} and a.expected
     order by a.account_id`);
  return rows.map((r) => ({ accountId: r.account_id, outcome: r.outcome, reason: r.reason, exceptionId: r.exception_id }));
}

export async function cycleCompleteness(tx: Transaction, cycleId: string): Promise<Completeness> {
  return completenessOf(await completenessRows(tx, cycleId));
}

/* ---------- outcomes (B-03, B-04) ---------- */

export async function recordOutcome(
  env: ActionEnv,
  input: z.infer<typeof outcomeInputSchema>,
  /** Who owns the queue item an exception outcome raises (NF-24); defaults to the actor, a run passes whoever started it. */
  owner: string | null = env.actor.userId,
): Promise<{ id: string; replayed: boolean; exceptionId: string | null }> {
  const { tx } = env;
  const row = await cycleRow(tx, input.cycleId, "share");
  const reason = input.reason?.trim() || null;
  if (input.id) {
    const [earlier] = await tx.select().from(cycleOutcome).where(eq(cycleOutcome.id, input.id));
    if (earlier) {
      const same = earlier.cycleId === input.cycleId && earlier.accountId === input.accountId && earlier.outcome === input.outcome && earlier.documentId === (input.documentId ?? null);
      if (!same) throw new TRPCError({ code: "CONFLICT", message: "That id was used for a different outcome" });
      return { id: earlier.id, replayed: true, exceptionId: earlier.exceptionId };
    }
  }
  if (row.state === "closed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Period ${row.period} is closed; correct it with a credit note, a debit note or a re-bill (B-14)` });
  const [member] = await tx.select().from(cycleAccount).where(and(eq(cycleAccount.cycleId, row.id), eq(cycleAccount.accountId, input.accountId)));
  if (!member) throw new TRPCError({ code: "NOT_FOUND", message: "That account is not in this cycle" });
  if (!member.expected) throw new TRPCError({ code: "BAD_REQUEST", message: `That account is not expected in this cycle (${member.reason})` });

  const billed = input.outcome === "billed" || input.outcome === "billed_estimate";
  let amount: bigint | null = null;
  if (billed) {
    if (!input.documentId) throw new TRPCError({ code: "BAD_REQUEST", message: "A billed outcome cites the document that billed the account" });
    const [doc] = await tx.select().from(document).where(eq(document.id, input.documentId));
    if (!doc || doc.accountId !== input.accountId || doc.kind === "reversal") throw new TRPCError({ code: "BAD_REQUEST", message: "That document is not a bill of this account" });
    amount = doc.total;
  } else {
    if (input.documentId) throw new TRPCError({ code: "BAD_REQUEST", message: "Only a billed outcome cites a document" });
    if (!reason) throw new TRPCError({ code: "BAD_REQUEST", message: `${input.outcome === "exception" ? "An exception" : "An exclusion"} needs a reason` });
  }

  const key = `cycle:${row.id}:${input.accountId}`;
  let exceptionId: string | null = null;
  if (input.outcome === "exception") {
    // NF-24: the account is on the exceptions queue with an owner; the outcome links to it.
    exceptionId = (
      await raiseException(tx, env.organizationId, {
        type: "UNBILLED_ACCOUNT",
        source: "billing",
        title: `Not billed for ${row.period}`,
        detail: reason ?? "",
        subject: { kind: "account", ref: input.accountId },
        routeId: row.routeId,
        ownerUserId: owner,
        dedupeKey: key,
      })
    ).id;
  } else {
    await resolveByDedupeKey(tx, key, `Outcome recorded: ${input.outcome}`);
  }
  const [saved] = await tx
    .insert(cycleOutcome)
    .values({
      ...(input.id ? { id: input.id } : {}),
      organizationId: env.organizationId,
      cycleId: row.id,
      accountId: input.accountId,
      outcome: input.outcome,
      reason,
      exceptionId,
      documentId: input.documentId ?? null,
      amount,
      flagged: input.flagged,
      actorUserId: env.actor.userId,
      source: env.source,
    })
    .returning({ id: cycleOutcome.id });
  await env.audit({ action: "billing.cycle_outcome", subjectType: "billing_cycle", subjectId: row.id, after: { accountId: input.accountId, outcome: input.outcome, reason, exceptionId, documentId: input.documentId ?? null } });
  await env.publish(cycleOutcomeRecorded, { cycleId: row.id, accountId: input.accountId, outcome: input.outcome, reason, exceptionId, documentId: input.documentId ?? null });
  return { id: saved!.id, replayed: false, exceptionId };
}

/* ---------- reads ---------- */

export async function listCycles(tx: Transaction, input: z.infer<typeof listInputSchema>) {
  const rows = await tx
    .select()
    .from(cycle)
    .where(and(input.routeId ? eq(cycle.routeId, input.routeId) : undefined, input.state ? eq(cycle.state, input.state) : undefined, input.period ? eq(cycle.period, input.period) : undefined))
    .orderBy(desc(cycle.period), asc(cycle.routeId))
    .limit(input.limit);
  return rows.map(toDto);
}

export async function cycleDetail(tx: Transaction, id: string) {
  const row = await cycleRow(tx, id);
  const events = await tx.select().from(cycleEvent).where(eq(cycleEvent.cycleId, id)).orderBy(asc(cycleEvent.seq));
  const snapshot = row.snapshotId ? await snapshotById(tx, row.snapshotId) : null;
  return {
    ...toDto(row),
    /** Whether the accounts came from Metering's snapshot or Accounts' facts (Metering unlicensed). */
    eligibilitySource: row.snapshotId ? ("metering_snapshot" as const) : ("accounts_fallback" as const),
    snapshotRows: snapshot?.rows.length ?? null,
    events: events.map((e) => ({ id: e.id, seq: e.seq, from: e.fromState, to: e.toState, kind: e.kind, reason: e.reason, actorUserId: e.actorUserId, at: e.createdAt })),
    completeness: await cycleCompleteness(tx, id),
  };
}

export interface CycleAccountRow {
  accountId: string;
  servicePointId: string | null;
  expected: boolean;
  snapshotReason: string;
  outcome: CycleOutcomeKind | null;
  outcomeId: string | null;
  reason: string | null;
  exceptionId: string | null;
  documentId: string | null;
  amount: bigint | null;
  flagged: boolean;
  /** The newest review decision on the current outcome. */
  review: "approve" | "hold" | null;
}

/** Accounts of a cycle with their current outcome and review, paged; `visible` limits a scoped viewer (K-03). */
export async function cycleAccounts(tx: Transaction, input: z.infer<typeof accountsInputSchema>, visible?: readonly string[]): Promise<{ total: number; rows: CycleAccountRow[] }> {
  await cycleRow(tx, input.cycleId);
  const filters = [
    sql`a.cycle_id = ${input.cycleId}`,
    input.expected === undefined ? sql`true` : sql`a.expected = ${input.expected}`,
    input.outcome === undefined ? sql`true` : input.outcome === "none" ? sql`(a.expected and o.outcome is null)` : sql`o.outcome = ${input.outcome}`,
    visible ? (visible.length ? sql`a.account_id in (${sql.join(visible.map((v) => sql`${v}`), sql`, `)})` : sql`false`) : sql`true`,
  ];
  const from = sql`
    from billing.cycle_account a
    left join lateral (
      select x.* from billing.cycle_outcome x
       where x.organization_id = a.organization_id and x.cycle_id = a.cycle_id and x.account_id = a.account_id
       order by x.seq desc limit 1) o on true
    left join lateral (
      select r.decision from billing.cycle_review r
       where r.organization_id = a.organization_id and r.cycle_id = a.cycle_id and r.account_id = a.account_id and r.outcome_id = o.id
       order by r.seq desc limit 1) rv on true
    where ${sql.join(filters, sql` and `)}`;
  const [count] = await tx.execute<{ n: string }>(sql`select count(*)::text as n ${from}`);
  const rows = await tx.execute<{
    account_id: string;
    service_point_id: string | null;
    expected: boolean;
    snapshot_reason: string;
    outcome: CycleOutcomeKind | null;
    outcome_id: string | null;
    reason: string | null;
    exception_id: string | null;
    document_id: string | null;
    amount: string | null;
    flagged: boolean | null;
    review: "approve" | "hold" | null;
  }>(sql`
    select a.account_id, a.service_point_id, a.expected, a.reason as snapshot_reason, o.outcome, o.id as outcome_id, o.reason, o.exception_id, o.document_id, o.amount::text as amount, o.flagged, rv.decision as review
    ${from} order by a.account_id limit ${input.limit} offset ${input.offset}`);
  return {
    total: Number(count?.n ?? 0),
    rows: rows.map((r) => ({
      accountId: r.account_id,
      servicePointId: r.service_point_id,
      expected: r.expected,
      snapshotReason: r.snapshot_reason,
      outcome: r.outcome,
      outcomeId: r.outcome_id,
      reason: r.reason,
      exceptionId: r.exception_id,
      documentId: r.document_id,
      amount: r.amount === null ? null : BigInt(r.amount),
      flagged: r.flagged ?? false,
      review: r.review,
    })),
  };
}

/* ---------- review (B-16) ---------- */

async function thresholds(tx: Transaction) {
  const s = (await readSetting(tx, billingReviewSetting)).value;
  const t: ReviewThresholds = { bulkApproveBelow: BigInt(s.bulkApproveBelow), individualAbove: BigInt(s.individualAbove) };
  return { settings: s, thresholds: t };
}

async function allBills(tx: Transaction, cycleId: string, visible?: readonly string[]) {
  const { rows } = await cycleAccounts(tx, { cycleId, expected: true, limit: 500, offset: 0 }, visible);
  const out = [...rows];
  // Page through the rest.
  for (let offset = 500; ; offset += 500) {
    const page = await cycleAccounts(tx, { cycleId, expected: true, limit: 500, offset }, visible);
    if (!page.rows.length) break;
    out.push(...page.rows);
  }
  return out.filter((r) => r.outcome === "billed" || r.outcome === "billed_estimate");
}

async function pendingReview(tx: Transaction, cycleId: string): Promise<number> {
  return (await allBills(tx, cycleId)).filter((b) => b.review !== "approve").length;
}

export interface ReviewItem extends CycleAccountRow {
  bucket: ReviewBucket;
}

/** Exception-based review list: the bills that are not approved yet, flagged and large ones first. */
export async function reviewQueue(tx: Transaction, cycleId: string, visible?: readonly string[]) {
  const { thresholds: t } = await thresholds(tx);
  const bills = await allBills(tx, cycleId, visible);
  const items: ReviewItem[] = bills.map((b) => ({ ...b, bucket: reviewBucket({ outcome: b.outcome!, amount: b.amount, flagged: b.flagged }, t)! }));
  const rank: Record<ReviewBucket, number> = { high: 0, attention: 1, clean: 2 };
  const pending = items.filter((i) => i.review !== "approve").sort((a, b) => rank[a.bucket] - rank[b.bucket] || (a.accountId < b.accountId ? -1 : 1));
  return { approved: items.length - pending.length, pending, held: pending.filter((p) => p.review === "hold").length };
}

function requireReviewState(row: CycleRow) {
  if (row.state !== "review") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Bills are reviewed in the review state (this cycle is in ${row.state})` });
}

/**
 * Approves every clean bill under the bulk threshold except a deterministic random sample,
 * which stays pending for a person to spot-check (`reviewAccount` with basis `sample`).
 * Running it again approves nothing more unless new clean bills arrived.
 */
export async function bulkApprove(env: UserActionEnv, cycleId: string) {
  const { tx } = env;
  const row = await cycleRow(tx, cycleId, true);
  requireReviewState(row);
  const { settings, thresholds: t } = await thresholds(tx);
  const bills = await allBills(tx, cycleId);
  const clean = bills.filter((b) => b.review === null && reviewBucket({ outcome: b.outcome!, amount: b.amount, flagged: b.flagged }, t) === "clean");
  const sample = new Set(sampleSelection(clean.map((b) => b.accountId), { rate: settings.sampleRate, minimum: settings.sampleMinimum, seed: cycleId }));
  const approve = clean.filter((b) => !sample.has(b.accountId));
  if (approve.length) {
    await tx.insert(cycleReview).values(approve.map((b) => ({ organizationId: env.organizationId, cycleId, accountId: b.accountId, outcomeId: b.outcomeId!, decision: "approve" as const, basis: "bulk" as const, actorUserId: env.actor.userId })));
  }
  const summary = { approved: approve.length, sample: [...sample].sort(), needAttention: bills.filter((b) => b.review === null).length - clean.length };
  if (approve.length) await env.audit({ action: "billing.cycle_bulk_approve", subjectType: "billing_cycle", subjectId: cycleId, after: { approved: approve.length, sample: summary.sample.length } });
  return summary;
}

export async function reviewAccount(env: UserActionEnv, input: z.infer<typeof reviewInputSchema>, canApproveHigh: boolean) {
  const { tx } = env;
  const row = await cycleRow(tx, input.cycleId, true);
  requireReviewState(row);
  const { rows } = await cycleAccounts(tx, { cycleId: input.cycleId, limit: 1, offset: 0 }, [input.accountId]);
  const current = rows[0];
  if (!current || (current.outcome !== "billed" && current.outcome !== "billed_estimate")) throw new TRPCError({ code: "NOT_FOUND", message: "No bill to review for that account" });
  const { thresholds: t } = await thresholds(tx);
  const bucket = reviewBucket({ outcome: current.outcome, amount: current.amount, flagged: current.flagged }, t);
  if (bucket === "high" && input.decision === "approve" && !canApproveHigh) throw new TRPCError({ code: "FORBIDDEN", message: "A bill this large is approved only by a member who may approve (billing:approve)" });
  if (input.decision === "hold" && !input.reason) throw new TRPCError({ code: "BAD_REQUEST", message: "Say why the bill is held" });
  if (current.review === input.decision) return { replayed: true, bucket };
  await tx.insert(cycleReview).values({ organizationId: env.organizationId, cycleId: input.cycleId, accountId: input.accountId, outcomeId: current.outcomeId!, decision: input.decision, basis: input.basis, reason: input.reason ?? null, actorUserId: env.actor.userId });
  await env.audit({ action: "billing.cycle_review", subjectType: "billing_cycle", subjectId: input.cycleId, after: { accountId: input.accountId, decision: input.decision, basis: input.basis, bucket, reason: input.reason ?? null } });
  return { replayed: false, bucket };
}
