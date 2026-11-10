import type { Transaction } from "@flowless/db";
import { revenueCase, REVENUE_CASE_DECISIONS, REVENUE_CASE_KINDS } from "@flowless/db/schema/billing";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { ActionEnv, UserActionEnv } from "../../kernel/action-env";
import { approvalOutcome } from "../../kernel/approval-store";
import { defineSetting, readSetting } from "../../kernel/config-store";
import { raiseException, resolveByDedupeKey } from "../../kernel/exception-store";
import { CORRECTION_APPROVAL_KIND } from "./approvals";
import { announceNote } from "./notes-announce";
import { lockAccount, postDraft } from "./post";
import { dimensionsOf, organizationCurrency, presentPosted, todayOf } from "./usage";

/*
 * Revenue-protection cases (B-19): illegal consumption (also raised by a reconnection whose
 * dial moved, B-12), terminated-but-consuming, unbilled accounts and back-billing. A case is
 * an append-only log (`billing.revenue_case`): opened, evidence, resolved with a decision.
 * Back-billing posts a debit note through the correction path (K-05 approval, a limit on how
 * far back it may reach), never an edit.
 */

export const revenueProtectionSchema = z.object({
  /** How many months before the current one a back-billing may start. */
  backBillMaxMonths: z.number().int().min(0).max(120).default(12),
  /** Back-billing needs an approved `billing.correction` request. */
  backBillRequiresApproval: z.boolean().default(true),
});
export const revenueProtectionSetting = defineSetting({
  key: "billing.revenue_protection",
  module: "billing",
  label: "Revenue protection",
  description: "How far back a back-billing may reach and whether it needs approval (B-19).",
  schema: revenueProtectionSchema,
  default: revenueProtectionSchema.parse({}),
});

export const caseKey = (caseId: string) => `case:${caseId}`;
export const backBillSubject = (accountId: string, caseId: string) => `correction:${accountId}:backbill:${caseId}`;

const refuse = (message: string, code: "PRECONDITION_FAILED" | "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" = "PRECONDITION_FAILED") => new TRPCError({ code, message });
type Row = typeof revenueCase.$inferSelect;

export const openInput = z.object({
  /** Client-minted: a retry returns the case. */
  id: z.uuid().optional(),
  kind: z.enum(REVENUE_CASE_KINDS),
  accountId: z.uuid(),
  servicePointId: z.uuid().optional(),
  title: z.string().trim().min(1).max(200),
  detail: z.string().trim().max(2000).default(""),
  data: z.record(z.string(), z.unknown()).optional(),
  fileId: z.uuid().optional(),
});
export type OpenInput = z.infer<typeof openInput>;

export const evidenceInput = z.object({
  id: z.uuid().optional(),
  caseId: z.uuid(),
  detail: z.string().trim().max(2000).default(""),
  fileId: z.uuid().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const backBillLine = z.object({
  description: z.string().trim().min(1).max(300),
  amount: z.bigint().positive().max(10n ** 15n),
  serviceFrom: z.iso.date(),
  serviceTo: z.iso.date(),
});
export const resolveInput = z.object({
  id: z.uuid().optional(),
  caseId: z.uuid(),
  decision: z.enum(REVENUE_CASE_DECISIONS),
  note: z.string().trim().min(1, "Say why").max(2000),
  /** Required for `back_billed`. */
  backBill: z.object({ invoiceTypeId: z.uuid(), lines: z.array(backBillLine).min(1).max(50), approvalId: z.uuid().optional() }).optional(),
});

async function events(tx: Transaction, caseId: string): Promise<Row[]> {
  return tx.select().from(revenueCase).where(eq(revenueCase.caseId, caseId)).orderBy(asc(revenueCase.seq));
}

export function present(rows: Row[]) {
  const head = rows[0]!;
  const resolved = rows.find((r) => r.event === "resolved");
  return {
    id: head.caseId,
    kind: head.kind,
    accountId: head.accountId,
    servicePointId: head.servicePointId,
    title: head.title,
    status: resolved ? ("resolved" as const) : ("open" as const),
    decision: resolved?.decision ?? null,
    openedAt: head.createdAt,
    openedByUserId: head.actorUserId,
    resolvedAt: resolved?.createdAt ?? null,
    documentId: resolved?.documentId ?? null,
    events: rows.map((r) => ({ id: r.id, event: r.event, detail: r.detail, data: r.data, fileId: r.fileId, decision: r.decision, documentId: r.documentId, actorUserId: r.actorUserId, source: r.source, createdAt: r.createdAt })),
  };
}
export type CaseView = ReturnType<typeof present>;

/** Opens a case and puts it in the exception queue (owner: whoever opened it). Idempotent by id. */
export async function openCase(env: ActionEnv, input: OpenInput): Promise<{ case: CaseView; replayed: boolean }> {
  const id = input.id ?? crypto.randomUUID();
  const [earlier] = await env.tx.select().from(revenueCase).where(eq(revenueCase.id, id));
  if (earlier) {
    if (earlier.event !== "opened" || earlier.accountId !== input.accountId || earlier.kind !== input.kind) throw refuse("That id was used for something else", "CONFLICT");
    return { case: present(await events(env.tx, id)), replayed: true };
  }
  const exception = await raiseException(env.tx, env.organizationId, {
    type: "REVENUE_CASE",
    source: "billing",
    title: input.title,
    detail: input.detail,
    subject: { kind: "account", ref: input.accountId },
    ownerUserId: env.actor.userId,
    dedupeKey: caseKey(id),
  });
  await env.tx.insert(revenueCase).values({
    id,
    caseId: id,
    organizationId: env.organizationId,
    event: "opened",
    kind: input.kind,
    accountId: input.accountId,
    servicePointId: input.servicePointId ?? null,
    title: input.title,
    detail: input.detail,
    data: input.data ?? null,
    fileId: input.fileId ?? null,
    exceptionId: exception.id,
    actorUserId: env.actor.userId,
    source: env.source,
  });
  await env.audit({ action: "billing.case_open", subjectType: "revenue_case", subjectId: id, after: { kind: input.kind, accountId: input.accountId, title: input.title, exceptionId: exception.id } });
  return { case: present(await events(env.tx, id)), replayed: false };
}

async function openCaseRow(tx: Transaction, caseId: string): Promise<Row> {
  const [head] = await tx.select().from(revenueCase).where(and(eq(revenueCase.id, caseId), eq(revenueCase.event, "opened")));
  if (!head) throw refuse("Case not found", "NOT_FOUND");
  return head;
}

export async function addEvidence(env: ActionEnv, input: z.infer<typeof evidenceInput>): Promise<CaseView> {
  const head = await openCaseRow(env.tx, input.caseId);
  if (!input.detail && !input.fileId) throw refuse("Add a note or a file", "BAD_REQUEST");
  if (input.id) {
    const [earlier] = await env.tx.select().from(revenueCase).where(eq(revenueCase.id, input.id));
    if (earlier) {
      if (earlier.caseId !== input.caseId || earlier.event !== "evidence") throw refuse("That id was used for something else", "CONFLICT");
      return present(await events(env.tx, input.caseId));
    }
  }
  const rows = await events(env.tx, input.caseId);
  if (rows.some((r) => r.event === "resolved")) throw refuse("The case is resolved; it takes no more evidence");
  await env.tx.insert(revenueCase).values({
    ...(input.id ? { id: input.id } : {}),
    caseId: input.caseId,
    organizationId: env.organizationId,
    event: "evidence",
    kind: head.kind,
    accountId: head.accountId,
    servicePointId: head.servicePointId,
    detail: input.detail,
    data: input.data ?? null,
    fileId: input.fileId ?? null,
    actorUserId: env.actor.userId,
    source: env.source,
  });
  await env.audit({ action: "billing.case_evidence", subjectType: "revenue_case", subjectId: input.caseId, after: { detail: input.detail, fileId: input.fileId ?? null } });
  return present(await events(env.tx, input.caseId));
}

const monthsBetween = (fromMonth: string, toMonth: string) => (Number(toMonth.slice(0, 4)) - Number(fromMonth.slice(0, 4))) * 12 + Number(toMonth.slice(5, 7)) - Number(fromMonth.slice(5, 7));

export async function resolveCase(env: UserActionEnv, input: z.infer<typeof resolveInput>): Promise<CaseView> {
  const head = await openCaseRow(env.tx, input.caseId);
  await lockAccount(env.tx, head.accountId);
  const rows = await events(env.tx, input.caseId);
  const done = rows.find((r) => r.event === "resolved");
  if (done) {
    if (input.id && done.id === input.id) return present(rows);
    throw refuse("The case is already resolved");
  }
  if ((input.decision === "back_billed") !== !!input.backBill) throw refuse("A back-billing decision needs the back-billing lines, and only it takes them", "BAD_REQUEST");

  let documentId: string | null = null;
  if (input.backBill) {
    const settings = (await readSetting(env.tx, revenueProtectionSetting)).value;
    const today = await todayOf(env.tx);
    const total = input.backBill.lines.reduce((s, l) => s + l.amount, 0n);
    for (const l of input.backBill.lines) {
      if (l.serviceTo < l.serviceFrom) throw refuse("A line's service span ends before it starts", "BAD_REQUEST");
      if (monthsBetween(l.serviceFrom.slice(0, 7), today.slice(0, 7)) > settings.backBillMaxMonths) {
        throw refuse(`Back-billing may reach back ${settings.backBillMaxMonths} month(s); ${l.serviceFrom} is further back`);
      }
    }
    let reasonCode = "BACK_BILLING";
    if (settings.backBillRequiresApproval) {
      if (!input.backBill.approvalId) throw refuse("Back-billing needs an approved request (cases.requestBackBilling)");
      const approval = await approvalOutcome(env.tx, input.backBill.approvalId);
      if (!approval || approval.kind !== CORRECTION_APPROVAL_KIND) throw refuse("There is no such approval for a back-billing", "NOT_FOUND");
      if (approval.subjectRef !== backBillSubject(head.accountId, input.caseId)) throw refuse("This approval is for another case");
      if (approval.status !== "approved") throw refuse(`The approval is ${approval.status}; back-billing needs an approved request`);
      if (approval.amount !== total) throw refuse("The lines total a different amount than was approved");
      reasonCode = approval.reasonCode ?? reasonCode;
    }
    const posted = await postDraft(env, {
      kind: "debit_note",
      entryType: "adjustment",
      invoiceTypeId: input.backBill.invoiceTypeId,
      accountId: head.accountId,
      currency: await organizationCurrency(env.tx),
      lines: input.backBill.lines.map((l) => ({ lineType: "adjustment" as const, description: l.description, amount: l.amount, serviceFrom: l.serviceFrom, serviceTo: l.serviceTo, chargeType: "adjustment" as const, calculation: { code: null, backBilling: true, caseId: input.caseId } })),
      issuedOn: today,
      note: `Back-billing, case ${input.caseId}: ${input.note}`.slice(0, 2000),
      idempotencyKey: `backbill:${input.caseId}`,
      dimensions: dimensionsOf({ servicePointId: head.servicePointId ?? undefined }),
    });
    await announceNote(env, posted, input.backBill.approvalId ?? "no-approval-required", reasonCode);
    documentId = posted.document.id;
    await presentPosted(env.tx, posted.document);
  }
  await env.tx.insert(revenueCase).values({
    ...(input.id ? { id: input.id } : {}),
    caseId: input.caseId,
    organizationId: env.organizationId,
    event: "resolved",
    kind: head.kind,
    accountId: head.accountId,
    servicePointId: head.servicePointId,
    detail: input.note,
    decision: input.decision,
    documentId,
    actorUserId: env.actor.userId,
    source: env.source,
  });
  await resolveByDedupeKey(env.tx, caseKey(input.caseId), `${input.decision}: ${input.note}`);
  await env.audit({ action: "billing.case_resolve", subjectType: "revenue_case", subjectId: input.caseId, after: { decision: input.decision, documentId }, reason: input.note });
  return present(await events(env.tx, input.caseId));
}

export const listInput = z
  .object({
    accountId: z.uuid().optional(),
    kind: z.enum(REVENUE_CASE_KINDS).optional(),
    status: z.enum(["open", "resolved"]).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .default({ limit: 50 });

export async function listCases(tx: Transaction, input: z.infer<typeof listInput>, accountIds?: string[]) {
  if (accountIds && accountIds.length === 0) return [];
  const heads = await tx
    .select()
    .from(revenueCase)
    .where(
      and(
        eq(revenueCase.event, "opened"),
        input.accountId ? eq(revenueCase.accountId, input.accountId) : undefined,
        input.kind ? eq(revenueCase.kind, input.kind) : undefined,
        accountIds ? inArray(revenueCase.accountId, accountIds) : undefined,
        input.status === "open" ? sql`not exists (select 1 from billing.revenue_case r where r.case_id = ${revenueCase.id} and r.event = 'resolved')` : undefined,
        input.status === "resolved" ? sql`exists (select 1 from billing.revenue_case r where r.case_id = ${revenueCase.id} and r.event = 'resolved')` : undefined,
      ),
    )
    .orderBy(desc(revenueCase.seq))
    .limit(input.limit);
  const out: CaseView[] = [];
  for (const h of heads) out.push(present(await events(tx, h.id)));
  return out;
}

export async function getCase(tx: Transaction, caseId: string): Promise<CaseView> {
  const rows = await events(tx, caseId);
  if (!rows.length) throw refuse("Case not found", "NOT_FOUND");
  return present(rows);
}
