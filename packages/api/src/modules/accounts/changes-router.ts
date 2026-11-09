import { SUCCESSION_BASES, RELOCATION_STATUSES, SURVEY_FEASIBILITIES } from "@flowless/shared-types";
import { relocation } from "@flowless/db/schema/accounts";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { router } from "../../trpc";
import { relocationVisible } from "./access";
import { changeName } from "./change-name";
import { procedureEnv } from "./commands";
import { NewCustomerInput } from "./customers";
import { holderAt, holdersOf } from "./holders";
import type { AccountsProcedures } from "./procedures";
import { findRelocation, relocationStepsOf, toRelocationDto, toRelocationStepDto } from "./relocation-present";
import { cancelRelocation, completeRelocation, recordRelocationSurvey, recordRelocationWork, requestRelocation } from "./relocations";
import { findAccount } from "./service";
import { succeedAccount } from "./succession";

/**
 * Succession (C-08), change of name (C-10) and relocation (C-09), merged into the Accounts
 * router. They are decisions about who holds an account and where it is served, so every
 * change needs `accounts:change_status` (owner, admin, manager); reads need `accounts:read`.
 * Each takes an optional client-minted `id`: the same id and request returns the earlier
 * result (`replayed: true`), a different request under it is CONFLICT. Each is audited and
 * logged in the account's command list as `succeed`, `change_name` or `relocate`.
 */

const accountId = z.uuid();
const Reason = z.string().trim().min(1, "Say why").max(500);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-03-31");
const Location = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

export function changesProcedureSet(p: AccountsProcedures) {
  return {
    /**
     * Creates the successor of an active or dormant account and makes the old one DORMANT with
     * a pointer (C-08). The successor has its own number, the same category and the customer
     * you name (default the same one, or `newCustomer`), and takes the service points. The
     * balance and the final reading move through the Ledger and Metering ports when they
     * exist; until then the command records `transfer: "pending_ledger"`.
     */
    succeed: p.status
      .input(
        z.object({
          id: z.uuid().optional(),
          accountId,
          basis: z.enum(SUCCESSION_BASES),
          customerId: z.uuid().optional(),
          newCustomer: NewCustomerInput.optional(),
          categoryId: z.uuid().nullable().optional(),
          servicePoints: z.enum(["move", "leave"]).optional(),
          reason: Reason,
        }),
      )
      .mutation(({ ctx, input }) => succeedAccount(procedureEnv(ctx), ctx.viewer, input)),

    /**
     * Changes the holder of the account from `effectiveDate` (today or earlier), keeping its
     * number (C-10). The previous holder keeps the periods before it (`holders.at`).
     */
    changeName: p.status
      .input(
        z
          .object({
            id: z.uuid().optional(),
            accountId,
            customerId: z.uuid().optional(),
            newCustomer: NewCustomerInput.optional(),
            effectiveDate: IsoDate,
            closingReadingRef: z.string().trim().min(1).max(100).optional(),
            reason: Reason,
          })
          .refine((v) => (v.customerId === undefined) !== (v.newCustomer === undefined), "Name the new holder: an existing customer or new customer details"),
      )
      .mutation(({ ctx, input }) => changeName(procedureEnv(ctx), ctx.viewer, input)),

    holders: router({
      /** The holders of the account over time, oldest first, each with the day the next took over. */
      list: p.read.input(z.object({ accountId })).query(async ({ ctx, input }) => {
        const row = await findAccount(ctx.tx, ctx.viewer, { id: input.accountId });
        return holdersOf(ctx.tx, row.id);
      }),
      /** Who held the account on a date (the same as `holderAt`, which Billing uses). Null before the first holder. */
      at: p.read.input(z.object({ accountId, date: IsoDate })).query(async ({ ctx, input }) => {
        const row = await findAccount(ctx.tx, ctx.viewer, { id: input.accountId });
        return holderAt(ctx.tx, row.id, input.date);
      }),
    }),

    relocations: router({
      /** Asks to move a service point of the account to a new place, optionally with fees to transfer (charge item codes, recorded not invoiced). */
      request: p.status
        .input(
          z.object({
            id: z.uuid().optional(),
            accountId,
            fromServicePointId: z.uuid(),
            to: z.object({
              address: z.string().trim().min(1).max(300),
              location: Location.optional(),
              schemeId: z.uuid().optional(),
              zoneId: z.uuid().optional(),
              dmaId: z.uuid().optional(),
              routeId: z.uuid().optional(),
            }),
            reason: Reason,
            feeItemCodes: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
          }),
        )
        .mutation(({ ctx, input }) => requestRelocation(procedureEnv(ctx), ctx.viewer, input)),

      recordSurvey: p.status
        .input(z.object({ id: z.uuid().optional(), relocationId: z.uuid(), feasibility: z.enum(SURVEY_FEASIBILITIES), findings: z.string().trim().min(1, "Say what the survey found").max(4000) }))
        .mutation(({ ctx, input }) => recordRelocationSurvey(procedureEnv(ctx), ctx.viewer, input)),

      /** The final reading of the old point and the initial reading of the new one, when the office has them (a completed `relocation` job records them too). */
      recordWork: p.status
        .input(z.object({ id: z.uuid().optional(), relocationId: z.uuid(), finalReading: z.string().trim().min(1).max(40).optional(), initialReading: z.string().trim().min(1).max(40).optional() }))
        .mutation(({ ctx, input }) => recordRelocationWork(procedureEnv(ctx), ctx.viewer, input)),

      /**
       * Completes the relocation: creates the new service point (zone, DMA and route are the
       * new place's), decommissions the old one and publishes `accounts.service_point_relocated`
       * for Billing and Metering. The account's number and status do not change.
       */
      complete: p.status
        .input(z.object({ id: z.uuid().optional(), relocationId: z.uuid(), reason: Reason.optional(), finalReading: z.string().trim().min(1).max(40).optional(), initialReading: z.string().trim().min(1).max(40).optional() }))
        .mutation(({ ctx, input }) => completeRelocation(procedureEnv(ctx), ctx.viewer, input)),

      cancel: p.status
        .input(z.object({ id: z.uuid().optional(), relocationId: z.uuid(), reason: Reason }))
        .mutation(({ ctx, input }) => cancelRelocation(procedureEnv(ctx), ctx.viewer, input)),

      get: p.read.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
        const row = await findRelocation(ctx.tx, ctx.viewer, input.id);
        return { ...toRelocationDto(row), events: (await relocationStepsOf(ctx.tx, row.id)).map(toRelocationStepDto) };
      }),

      list: p.read
        .input(z.object({ accountId: accountId.optional(), status: z.enum(RELOCATION_STATUSES).optional(), after: z.uuid().optional(), limit: z.number().int().min(1).max(200).default(50) }).optional())
        .query(async ({ ctx, input }) => {
          let cursor;
          if (input?.after) {
            const [row] = await ctx.tx.select({ id: relocation.id }).from(relocation).where(and(eq(relocation.id, input.after), relocationVisible(ctx.viewer)));
            if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Relocation not found" });
            cursor = sql`(${relocation.requestedAt}, ${relocation.id}) > (select r.requested_at, r.id from accounts.relocation r where r.id = ${row.id}::uuid)`;
          }
          const rows = await ctx.tx
            .select()
            .from(relocation)
            .where(and(relocationVisible(ctx.viewer), input?.accountId ? eq(relocation.accountId, input.accountId) : undefined, input?.status ? eq(relocation.status, input.status) : undefined, cursor))
            .orderBy(asc(relocation.requestedAt), asc(relocation.id))
            .limit(input?.limit ?? 50);
          return rows.map(toRelocationDto);
        }),
    }),
  };
}
