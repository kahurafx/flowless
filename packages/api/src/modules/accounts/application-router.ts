import { application } from "@flowless/db/schema/accounts";
import { APPLICATION_STAGES, SURVEY_FEASIBILITIES } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { readSetting } from "../../kernel/config-store";
import { router } from "../../trpc";
import { applicationVisible } from "./access";
import {
  advanceApplication,
  convertApplication,
  createApplication,
  endApplication,
  eventsOf,
  findApplication,
  presentApplication,
  recordSurvey,
  toEventDto,
  type AdvanceRequest,
} from "./applications";
import { activeStages } from "./application-stages";
import { procedureEnv } from "./commands";
import { NewCustomerInput } from "./customers";
import type { AccountsProcedures } from "./procedures";
import { applicationSetting } from "./settings";
import { surveyApproval } from "./survey-approval";

/**
 * The application workflow (C-05), mounted at `accounts.applications`. Reads need
 * `accounts:read`; logging an enquiry and converting (which opens the account) need
 * `accounts:create`; every other step needs `accounts:update`. Survey approval is K-05, so
 * it is decided through `approvals.approve` by the holders of the policy's level permissions
 * (default `accounts:change_status`; a second level is usually `billing:approve`).
 *
 * Every step takes an optional client-minted `id`: repeating it with the same request
 * returns the earlier result (`replayed: true`), a different request under it is CONFLICT.
 * `markInvoiced` and `markPaid` take opaque references until Billing and Payments exist.
 */

const applicationId = z.uuid();
const Reason = z.string().trim().min(1, "Say why").max(500);
const Optional = z.string().trim().min(1).max(500).optional();
const Ref = z.string().trim().min(1).max(100);
const Location = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

const step = { id: z.uuid().optional(), applicationId, reason: Optional };

export function applicationsRouter(p: AccountsProcedures) {
  type Ctx = Parameters<typeof procedureEnv>[0];
  const env = (ctx: Ctx) => procedureEnv(ctx);

  const advance = (action: AdvanceRequest["action"], fallback: string) =>
    p.update.input(z.object(step)).mutation(({ ctx, input }) =>
      advanceApplication(env(ctx), ctx.viewer, { id: input.id, applicationId: input.applicationId, action, reason: input.reason ?? fallback }),
    );

  return router({
    /** Logs an enquiry for a new connection: an existing customer or new customer details, the category wanted and the place. */
    create: p.create
      .input(
        z
          .object({
            id: z.uuid().optional(),
            customerId: z.uuid().optional(),
            newCustomer: NewCustomerInput.optional(),
            /** Tariffs' category; checked when Tariffs is licensed, opaque otherwise. */
            requestedCategoryId: z.uuid().optional(),
            /** The account this connection is a child of (C-07), with its membership class. */
            parentAccountId: z.uuid().optional(),
            membershipClass: z.string().trim().min(1).max(30).optional(),
            address: z.string().trim().min(1).max(300),
            location: Location.optional(),
            schemeId: z.uuid().optional(),
            zoneId: z.uuid().optional(),
            dmaId: z.uuid().optional(),
            routeId: z.uuid().optional(),
            notes: z.string().trim().max(4000).optional(),
          })
          .refine((v) => (v.customerId === undefined) !== (v.newCustomer === undefined), "Name the customer: an existing one or new customer details"),
      )
      .mutation(({ ctx, input }) => createApplication(env(ctx), ctx.viewer, input)),

    /** The application with its history (every stage change, the survey and its decision). */
    get: p.read.input(z.object({ id: applicationId })).query(async ({ ctx, input }) => {
      const row = await findApplication(ctx.tx, ctx.viewer, input.id);
      return { ...(await presentApplication(ctx.tx, row)), events: (await eventsOf(ctx.tx, row.id)).map(toEventDto) };
    }),

    /** Oldest first; pass the last id of a page as `after`. */
    list: p.read
      .input(
        z
          .object({
            stage: z.enum(APPLICATION_STAGES).optional(),
            customerId: z.uuid().optional(),
            after: z.uuid().optional(),
            limit: z.number().int().min(1).max(200).default(50),
          })
          .optional(),
      )
      .query(async ({ ctx, input }) => {
        let cursor;
        if (input?.after) {
          const [row] = await ctx.tx.select({ id: application.id }).from(application).where(and(eq(application.id, input.after), applicationVisible(ctx.viewer)));
          if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
          cursor = sql`(${application.createdAt}, ${application.id}) > (select a.created_at, a.id from accounts.application a where a.id = ${row.id}::uuid)`;
        }
        const rows = await ctx.tx
          .select()
          .from(application)
          .where(
            and(
              applicationVisible(ctx.viewer),
              input?.stage ? eq(application.stage, input.stage) : undefined,
              input?.customerId ? eq(application.customerId, input.customerId) : undefined,
              cursor,
            ),
          )
          .orderBy(asc(application.createdAt), asc(application.id))
          .limit(input?.limit ?? 50);
        return Promise.all(rows.map((r) => presentApplication(ctx.tx, r)));
      }),

    /** The stages this organization uses (the setting in force), for drawing the workflow. */
    stages: p.read.query(async ({ ctx }) => {
      const config = (await readSetting(ctx.tx, applicationSetting)).value;
      return { config, stages: activeStages(config) };
    }),

    /**
     * Records the survey's result: findings, feasible or not, and a note of the materials
     * needed. A feasible one asks for approval (K-05, `approvals.accounts.connection_survey`:
     * none, one or two levels) and the application moves to `survey` once approved. Anyone
     * with `accounts:update` can record it, whether or not Work Orders is licensed.
     */
    recordSurvey: p.update
      .input(
        z.object({
          id: z.uuid().optional(),
          applicationId,
          feasibility: z.enum(SURVEY_FEASIBILITIES),
          findings: z.string().trim().min(1, "Say what the survey found").max(4000),
          materialsNote: z.string().trim().max(2000).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        recordSurvey(env(ctx), ctx.viewer, {
          id: input.id,
          applicationId: input.applicationId,
          result: { feasibility: input.feasibility, findings: input.findings, materialsNote: input.materialsNote },
          source: "office",
          ask: (request) => ctx.requestApproval(surveyApproval, request),
        }),
      ),

    submitApplication: advance("submitApplication", "Application submitted"),
    /** The new-connection invoice is out: its reference (opaque until Billing, Phase 4, which replaces this with an event). */
    markInvoiced: p.update
      .input(z.object({ ...step, invoiceRef: Ref }))
      .mutation(({ ctx, input }) =>
        advanceApplication(env(ctx), ctx.viewer, {
          id: input.id,
          applicationId: input.applicationId,
          action: "markInvoiced",
          reason: input.reason ?? "New-connection invoice issued",
          invoiceRef: input.invoiceRef,
        }),
      ),
    /** The invoice is paid: the payment's reference (opaque until Payments, Phase 6, which replaces this with an event). */
    markPaid: p.update
      .input(z.object({ ...step, paymentRef: Ref }))
      .mutation(({ ctx, input }) =>
        advanceApplication(env(ctx), ctx.viewer, {
          id: input.id,
          applicationId: input.applicationId,
          action: "markPaid",
          reason: input.reason ?? "New-connection invoice paid",
          paymentRef: input.paymentRef,
        }),
      ),
    startInstallation: advance("startInstallation", "Installation started"),
    markReady: advance("markReady", "Installed and ready"),

    /**
     * Turns a ready application into an account and its service point, and moves the account
     * NEW to PENDING_PAYMENT when the organization uses the new-connection invoice. Activation
     * is the lifecycle's gates (`accounts.activation.*`, `accounts.activate`).
     */
    convert: p.create
      .input(z.object(step))
      .mutation(({ ctx, input }) =>
        convertApplication(env(ctx), ctx.viewer, { id: input.id, applicationId: input.applicationId, reason: input.reason ?? "Application converted to an account" }),
      ),

    reject: p.update
      .input(z.object({ id: z.uuid().optional(), applicationId, reason: Reason }))
      .mutation(({ ctx, input }) => endApplication(env(ctx), ctx.viewer, { ...input, to: "rejected" })),
    cancel: p.update
      .input(z.object({ id: z.uuid().optional(), applicationId, reason: Reason }))
      .mutation(({ ctx, input }) => endApplication(env(ctx), ctx.viewer, { ...input, to: "cancelled" })),
  });
}
