import { document } from "@flowless/db/schema/billing";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { procedureEnv } from "../../kernel/action-env";
import { router } from "../../trpc";
import { adjustmentApproval } from "./approvals";
import { adjustmentSubject, issueNote, noteInputSchema, NOTE_KINDS } from "./notes";
import { billingProcedures as p } from "./procedures";
import { accountBalance, accountStatement, documentWithLines, listDocuments } from "./reads";
import { rebill, rebillInputSchema, voidDocument, voidInputSchema } from "./reversal";
import { issueUsage, usageInputSchema } from "./usage";

const accountId = z.uuid();

/**
 * The Billing router (B-10, B-11, B-14, B-18, T-04), mounted at `billing`:
 * - `invoices.issueUsage` prices a reading or estimate with the engine and posts it (or holds it as an exception).
 * - `adjustments.request`, `creditNotes.issue`, `debitNotes.issue`: notes behind a K-05 approval.
 * - `documents.void`, `documents.rebill`: reversal and replacement, never an edit.
 * - `balance`, `statement`, `documents.get`, `documents.list`: derived reads.
 */
export const billingRouter = router({
  invoices: router({
    issueUsage: p.issue.input(usageInputSchema).mutation(({ ctx, input }) => issueUsage(procedureEnv(ctx), input)),
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
    issue: p.adjust.input(noteInputSchema).mutation(({ ctx, input }) => issueNote(procedureEnv(ctx), "credit_note", input)),
  }),
  debitNotes: router({
    issue: p.adjust.input(noteInputSchema).mutation(({ ctx, input }) => issueNote(procedureEnv(ctx), "debit_note", input)),
  }),

  documents: router({
    get: p.read.input(z.object({ id: z.uuid() })).query(({ ctx, input }) => documentWithLines(ctx.tx, input.id)),
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
      .query(({ ctx, input }) => listDocuments(ctx.tx, input)),
    void: p.adjust.input(voidInputSchema).mutation(({ ctx, input }) => voidDocument(procedureEnv(ctx), input)),
    rebill: p.adjust.input(rebillInputSchema).mutation(({ ctx, input }) => rebill(procedureEnv(ctx), input)),
  }),

  /** What the account owes now or as of a date, summed from ledger entries. */
  balance: p.read.input(z.object({ accountId, asOf: z.iso.date().optional() })).query(({ ctx, input }) => accountBalance(ctx.tx, input.accountId, input.asOf)),

  /** The account's statement with a running balance, from ledger entries. */
  statement: p.read
    .input(z.object({ accountId, from: z.iso.date().optional(), to: z.iso.date().optional(), limit: z.number().int().min(1).max(1000).default(200), offset: z.number().int().min(0).default(0) }))
    .query(({ ctx, input }) => accountStatement(ctx.tx, input.accountId, { limit: input.limit, offset: input.offset, ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}) })),
});
