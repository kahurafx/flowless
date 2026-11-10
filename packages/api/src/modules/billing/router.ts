import { document } from "@flowless/db/schema/billing";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { procedureEnv } from "../../kernel/action-env";
import { router } from "../../trpc";
import { TRPCError } from "@trpc/server";
import { adjustmentApproval, correctionApproval } from "./approvals";
import { addEvidence, backBillSubject, evidenceInput, getCase, listCases, listInput as caseListInput, openCase, openInput as caseOpenInput, resolveCase, resolveInput as caseResolveInput } from "./cases";
import { correctionSubject, decideRoute, evidenceSchema, postCorrection, postCorrectionInput, proposeCorrection } from "./corrections";
import { disconnect, disconnectInput, reconnect, reconnectInput } from "./disconnections";
import { finalInputSchema, issueFinal } from "./final";
import { assertAccountVisible, assertDocumentVisible, listableAccounts } from "./scope";
import { adjustmentSubject, issueNote, noteInputSchema, NOTE_KINDS } from "./notes";
import { billingProcedures as p } from "./procedures";
import { accountBalance, accountStatement, documentWithLines, listDocuments } from "./reads";
import { rebill, rebillInputSchema, voidDocument, voidInputSchema } from "./reversal";
import { issueUsage, usageInputSchema } from "./usage";
import { cycleProgress, runCycle } from "./cycle-progress";
import { runSimulation, simulationInputSchema } from "./simulation";
import {
  accountsInputSchema,
  advanceCycle,
  advanceInputSchema,
  bulkApprove,
  closeCycle,
  closeInputSchema,
  cycleAccounts,
  cycleCompleteness,
  cycleDetail,
  listCycles,
  listInputSchema,
  openCycle,
  openInputSchema,
  outcomeInputSchema,
  recordOutcome,
  reviewAccount,
  reviewInputSchema,
  reviewQueue,
} from "./cycles";

const accountId = z.uuid();
const cycleDetailExists = async (tx: Parameters<typeof cycleDetail>[0], id: string) => void (await cycleDetail(tx, id));

/**
 * The Billing router (B-10, B-11, B-14, B-18, T-04), mounted at `billing`:
 * - `invoices.issueUsage` prices a reading or estimate with the engine and posts it (or holds it as an exception).
 * - `adjustments.request`, `creditNotes.issue`, `debitNotes.issue`: notes behind a K-05 approval.
 * - `documents.void`, `documents.rebill`: reversal and replacement, never an edit.
 * - `balance`, `statement`, `documents.get`, `documents.list`: derived reads.
 */
export const billingRouter = router({
  invoices: router({
    issueUsage: p.issue.input(usageInputSchema).mutation(async ({ ctx, input }) => {
      await assertAccountVisible(ctx.tx, ctx.viewer, input.accountId);
      return issueUsage(procedureEnv(ctx), input);
    }),
    /** B-12: the final bill on disconnection, once per event key; Accounts' termination check looks for it. */
    issueFinal: p.issue.input(finalInputSchema).mutation(async ({ ctx, input }) => {
      await assertAccountVisible(ctx.tx, ctx.viewer, input.accountId);
      return issueFinal(procedureEnv(ctx), input);
    }),
  }),

  adjustments: router({
    /** Asks for approval (K-05) of a credit or debit note of this size for this account. */
    request: p.adjust
      .input(
        z.object({
          id: z.uuid().optional(),
          accountId,
          kind: z.enum(NOTE_KINDS),
          amount: z.bigint().positive(),
          reasonCode: z.string().refine((c) => adjustmentApproval.reasonCodes.some((r) => r.code === c), "Choose a reason"),
          note: z.string().trim().min(1, "Say why").max(2000),
          relatedDocumentId: z.uuid().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await assertAccountVisible(ctx.tx, ctx.viewer, input.accountId);
        const request = await ctx.requestApproval(adjustmentApproval, {
          subjectRef: adjustmentSubject(input.kind, input.accountId, input.id ?? randomUUID()),
          title: `${input.kind === "credit_note" ? "Credit" : "Debit"} note for account ${input.accountId}`,
          amount: input.amount,
          reasonCode: input.reasonCode,
          note: input.note,
          payload: { accountId: input.accountId, kind: input.kind, relatedDocumentId: input.relatedDocumentId ?? null },
        });
        return { approvalId: request.id, status: request.status };
      }),
  }),

  creditNotes: router({
    issue: p.adjust.input(noteInputSchema).mutation(async ({ ctx, input }) => {
      await assertAccountVisible(ctx.tx, ctx.viewer, input.accountId);
      return issueNote(procedureEnv(ctx), "credit_note", input);
    }),
  }),
  debitNotes: router({
    issue: p.adjust.input(noteInputSchema).mutation(async ({ ctx, input }) => {
      await assertAccountVisible(ctx.tx, ctx.viewer, input.accountId);
      return issueNote(procedureEnv(ctx), "debit_note", input);
    }),
  }),

  documents: router({
    get: p.read.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
      await assertDocumentVisible(ctx.tx, ctx.viewer, input.id);
      return documentWithLines(ctx.tx, input.id);
    }),
    list: p.read
      .input(
        z.object({
          accountId: accountId.optional(),
          kind: z.enum(document.kind.enumValues).optional(),
          before: z.date().optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .default({ limit: 50 }),
      )
      .query(async ({ ctx, input }) => {
        if (input.accountId) await assertAccountVisible(ctx.tx, ctx.viewer, input.accountId);
        return listDocuments(ctx.tx, { ...input, accountIds: input.accountId ? undefined : await listableAccounts(ctx.tx, ctx.viewer) });
      }),
    void: p.adjust.input(voidInputSchema).mutation(async ({ ctx, input }) => {
      await assertDocumentVisible(ctx.tx, ctx.viewer, input.documentId);
      return voidDocument(procedureEnv(ctx), input);
    }),
    rebill: p.adjust.input(rebillInputSchema).mutation(async ({ ctx, input }) => {
      await assertDocumentVisible(ctx.tx, ctx.viewer, input.documentId);
      return rebill(procedureEnv(ctx), input);
    }),
  }),

  /**
   * Billing cycles (B-01 to B-04, B-15, B-16): one per route and period, driven by logged
   * state events; closing needs every expected account explained and locks the period.
   */
  cycles: router({
    open: p.issue.input(openInputSchema).mutation(({ ctx, input }) => openCycle(procedureEnv(ctx), input)),
    list: p.read.input(listInputSchema).query(({ ctx, input }) => listCycles(ctx.tx, input)),
    get: p.read.input(z.object({ cycleId: z.uuid() })).query(({ ctx, input }) => cycleDetail(ctx.tx, input.cycleId)),
    /** Backward and skipping moves need a reason. */
    advance: p.issue.input(advanceInputSchema).mutation(({ ctx, input }) => advanceCycle(procedureEnv(ctx), input)),
    close: p.issue.input(closeInputSchema).mutation(({ ctx, input }) => closeCycle(procedureEnv(ctx), input)),
    accounts: p.read.input(accountsInputSchema).query(async ({ ctx, input }) => cycleAccounts(ctx.tx, input, await listableAccounts(ctx.tx, ctx.viewer))),
    completeness: p.read.input(z.object({ cycleId: z.uuid() })).query(async ({ ctx, input }) => {
      await cycleDetailExists(ctx.tx, input.cycleId);
      return cycleCompleteness(ctx.tx, input.cycleId);
    }),
    /** B-07: queue the per-account jobs for accounts without an outcome (resume); safe to repeat. */
    run: p.issue.input(z.object({ cycleId: z.uuid() })).mutation(({ ctx, input }) => runCycle(procedureEnv(ctx), input.cycleId, false)),
    /** The same plus accounts whose newest outcome is an exception. */
    retry: p.issue.input(z.object({ cycleId: z.uuid() })).mutation(({ ctx, input }) => runCycle(procedureEnv(ctx), input.cycleId, true)),
    progress: p.read.input(z.object({ cycleId: z.uuid() })).query(({ ctx, input }) => cycleProgress(ctx.tx, input.cycleId)),
    recordOutcome: p.issue.input(outcomeInputSchema).mutation(async ({ ctx, input }) => {
      await assertAccountVisible(ctx.tx, ctx.viewer, input.accountId);
      return recordOutcome(procedureEnv(ctx), input);
    }),
    review: router({
      queue: p.read.input(z.object({ cycleId: z.uuid() })).query(async ({ ctx, input }) => reviewQueue(ctx.tx, input.cycleId, await listableAccounts(ctx.tx, ctx.viewer))),
      bulkApprove: p.issue.input(z.object({ cycleId: z.uuid() })).mutation(({ ctx, input }) => bulkApprove(procedureEnv(ctx), input.cycleId)),
      decide: p.issue.input(reviewInputSchema).mutation(async ({ ctx, input }) => {
        await assertAccountVisible(ctx.tx, ctx.viewer, input.accountId);
        return reviewAccount(procedureEnv(ctx), input, ctx.permissions.has("billing:approve"));
      }),
    }),
  }),

  /**
   * B-12: one command to disconnect (final reading, final bill, Accounts' status command) and one
   * to reconnect (from the final reading; a moved dial opens an illegal-consumption case).
   * Needs billing:run and accounts:change_status.
   */
  disconnections: router({
    disconnect: p.disconnect.input(disconnectInput).mutation(async ({ ctx, input }) => {
      await assertAccountVisible(ctx.tx, ctx.viewer, input.accountId);
      return disconnect(procedureEnv(ctx), ctx.viewer, input);
    }),
    reconnect: p.disconnect.input(reconnectInput).mutation(async ({ ctx, input }) => {
      await assertAccountVisible(ctx.tx, ctx.viewer, input.accountId);
      return reconnect(procedureEnv(ctx), ctx.viewer, input);
    }),
  }),

  /**
   * B-13, B-14: late and corrected readings post in the current open period as credit or debit
   * notes citing the original invoice. Inside the grace window billing:run posts; after it an
   * approved `billing.correction` request is needed; a large deviation needs evidence.
   */
  corrections: router({
    preview: p.read
      .input(z.object({ accountId, period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), evidence: evidenceSchema.optional() }))
      .query(async ({ ctx, input }) => {
        await assertAccountVisible(ctx.tx, ctx.viewer, input.accountId);
        const proposal = await proposeCorrection(procedureEnv(ctx), input);
        if (!proposal) return { documents: [], problems: [], decision: null };
        return {
          documents: proposal.documents.map((d) => ({ period: d.period, kind: d.kind, total: d.total, relatedDocumentId: d.original?.id ?? null, originalNumber: d.original?.number ?? null, text: d.text, lines: d.lines })),
          problems: proposal.problems,
          decision: await decideRoute(ctx.tx, proposal, input.evidence),
        };
      }),
    /** Asks the K-05 approval a correction needs after the grace window. */
    request: p.issue
      .input(
        z.object({
          accountId,
          period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
          reasonCode: z.string().refine((c) => correctionApproval.reasonCodes.some((r) => r.code === c), "Choose a reason"),
          note: z.string().trim().min(1, "Say why").max(2000),
          evidence: evidenceSchema.optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await assertAccountVisible(ctx.tx, ctx.viewer, input.accountId);
        const proposal = await proposeCorrection(procedureEnv(ctx), input);
        if (!proposal || proposal.documents.length === 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "There is nothing to correct for that period" });
        const route = await decideRoute(ctx.tx, proposal, input.evidence);
        if (route.needsEvidence) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This is a large correction: attach evidence first" });
        const request = await ctx.requestApproval(correctionApproval, {
          subjectRef: correctionSubject(input.accountId, input.period),
          title: `Correction for account ${input.accountId}, ${input.period}`,
          amount: route.amount,
          reasonCode: input.reasonCode,
          note: input.note,
          payload: { accountId: input.accountId, period: input.period, route: route.route },
        });
        return { approvalId: request.id, status: request.status, amount: route.amount };
      }),
    post: p.issue.input(postCorrectionInput).mutation(async ({ ctx, input }) => {
      await assertAccountVisible(ctx.tx, ctx.viewer, input.accountId);
      return postCorrection(procedureEnv(ctx), input);
    }),
  }),

  /** B-19: revenue-protection cases as an append-only log; back-billing goes through approval. */
  cases: router({
    list: p.read.input(caseListInput).query(async ({ ctx, input }) => {
      if (input.accountId) await assertAccountVisible(ctx.tx, ctx.viewer, input.accountId);
      return listCases(ctx.tx, input, input.accountId ? undefined : await listableAccounts(ctx.tx, ctx.viewer));
    }),
    get: p.read.input(z.object({ caseId: z.uuid() })).query(async ({ ctx, input }) => {
      const found = await getCase(ctx.tx, input.caseId);
      await assertAccountVisible(ctx.tx, ctx.viewer, found.accountId);
      return found;
    }),
    open: p.issue.input(caseOpenInput).mutation(async ({ ctx, input }) => {
      await assertAccountVisible(ctx.tx, ctx.viewer, input.accountId);
      return openCase(procedureEnv(ctx), input);
    }),
    addEvidence: p.issue.input(evidenceInput).mutation(async ({ ctx, input }) => {
      await assertAccountVisible(ctx.tx, ctx.viewer, (await getCase(ctx.tx, input.caseId)).accountId);
      return addEvidence(procedureEnv(ctx), input);
    }),
    resolve: p.issue.input(caseResolveInput).mutation(async ({ ctx, input }) => {
      await assertAccountVisible(ctx.tx, ctx.viewer, (await getCase(ctx.tx, input.caseId)).accountId);
      return resolveCase(procedureEnv(ctx), input);
    }),
    /** Asks the approval a back-billing needs (`billing.revenue_protection`). */
    requestBackBilling: p.issue
      .input(z.object({ caseId: z.uuid(), amount: z.bigint().positive(), note: z.string().trim().min(1, "Say why").max(2000) }))
      .mutation(async ({ ctx, input }) => {
        const found = await getCase(ctx.tx, input.caseId);
        await assertAccountVisible(ctx.tx, ctx.viewer, found.accountId);
        if (found.status === "resolved") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The case is resolved" });
        const request = await ctx.requestApproval(correctionApproval, {
          subjectRef: backBillSubject(found.accountId, input.caseId),
          title: `Back-billing, case ${input.caseId}`,
          amount: input.amount,
          reasonCode: "BACK_BILLING",
          note: input.note,
          payload: { accountId: found.accountId, caseId: input.caseId },
        });
        return { approvalId: request.id, status: request.status };
      }),
  }),

  /**
   * T-06: prices the last N billed consumption spans of a selection of accounts under a draft
   * tariff and under the tariff in force, with per-account and total deltas. Writes nothing.
   * Needs billing:read and tariffs:read (or tariffs:manage).
   */
  simulation: router({
    run: p.read.input(simulationInputSchema).query(async ({ ctx, input }) => {
      if (!ctx.permissions.has("tariffs:read") && !ctx.permissions.has("tariffs:manage")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Simulating a tariff needs tariffs:read or tariffs:manage" });
      }
      return runSimulation(procedureEnv(ctx), input, await listableAccounts(ctx.tx, ctx.viewer));
    }),
  }),

  /** What the account owes now or as of a date, summed from ledger entries. */
  balance: p.read.input(z.object({ accountId, asOf: z.iso.date().optional() })).query(async ({ ctx, input }) => {
    await assertAccountVisible(ctx.tx, ctx.viewer, input.accountId);
    return accountBalance(ctx.tx, input.accountId, input.asOf);
  }),

  /** The account's statement with a running balance, from ledger entries. */
  statement: p.read
    .input(z.object({ accountId, from: z.iso.date().optional(), to: z.iso.date().optional(), limit: z.number().int().min(1).max(1000).default(200), offset: z.number().int().min(0).default(0) }))
    .query(async ({ ctx, input }) => {
      await assertAccountVisible(ctx.tx, ctx.viewer, input.accountId);
      return accountStatement(ctx.tx, input.accountId, { limit: input.limit, offset: input.offset, ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}) });
    }),
});
