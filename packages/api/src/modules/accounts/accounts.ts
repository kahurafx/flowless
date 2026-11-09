import { account, customer, customerContact, servicePoint } from "@flowless/db/schema/accounts";
import { COMMERCIAL_STATUSES, SERVICE_STATES, parsePhone } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { procedureEnv } from "../../kernel/action-env";
import { descendantsOf } from "../../kernel/scope";
import { accountVisible, servicePointInScope } from "./access";
import { openAccount } from "./open-account";
import type { AccountsProcedures } from "./procedures";
import {
  callingCodeFor,
  findAccount,
  likeEscape,
  presentAccount,
  presentAccounts,
  previewNextNumber,
  toAccountDto,
  toServicePointDto,
  usablePhone,
  contactsOf,
} from "./service";
import { numberingSetting } from "./settings";

const Number_ = z.string().trim().min(1).max(40);
const Page = z.number().int().min(1).max(200).default(50);

/** Accounts (C-02, C-03), mounted at the module's root: `accounts.create`, `accounts.get`, ... */
export function accountProcedureSet(p: AccountsProcedures) {
  return {
    /**
     * Opens an account for a customer with the next number of the organization's format
     * (C-02), starting NEW and DISCONNECTED (C-03). With `parentAccountId` it is a child:
     * `numbering: "suffix"` (the default for a top-level parent) takes the parent's number
     * plus the next letter ("1008B"); `"own"` takes a number of its own ("1009") and only
     * records the link. Status changes are the account lifecycle (Phase 3 F3).
     */
    create: p.create
      .input(
        z.object({
          customerId: z.uuid(),
          parentAccountId: z.uuid().optional(),
          numbering: z.enum(["suffix", "own"]).optional(),
          /** Tariffs' category (T-02); validated by Tariffs once it ships, opaque here. */
          categoryId: z.uuid().optional(),
          /** A membership class (C-07) of this organization; the account must be a child. */
          membershipClass: z.string().trim().min(1).max(30).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => presentAccount(ctx.tx, await openAccount(procedureEnv(ctx), ctx.viewer, input))),

    /** An account with its customer's contact details, parent, children and service points, by id or number. */
    get: p.read
      .input(z.union([z.object({ id: z.uuid() }), z.object({ number: Number_ })]))
      .query(async ({ ctx, input }) => {
        const row = await findAccount(ctx.tx, ctx.viewer, input);
        const [customerRow] = await ctx.tx.select().from(customer).where(eq(customer.id, row.customerId));
        const contacts = await contactsOf(ctx.tx, [row.customerId]);
        const [parent] = row.parentAccountId
          ? await ctx.tx.select({ id: account.id, number: account.number }).from(account).where(eq(account.id, row.parentAccountId))
          : [];
        const children = await ctx.tx
          .select({ id: account.id, number: account.number, suffixIndex: account.suffixIndex })
          .from(account)
          .where(and(eq(account.parentAccountId, row.id), accountVisible(ctx.viewer)))
          .orderBy(asc(account.number));
        const points = await ctx.tx
          .select()
          .from(servicePoint)
          .where(and(eq(servicePoint.accountId, row.id), servicePointInScope(ctx.viewer.scope)))
          .orderBy(asc(servicePoint.createdAt), asc(servicePoint.id));
        return {
          ...toAccountDto(row, { name: customerRow!.name, type: customerRow!.type }, usablePhone(contacts)),
          parent: parent ?? null,
          children,
          servicePoints: points.map(toServicePointDto),
        };
      }),

    /** Number order; pass the last number of a page as `after` for the next one. */
    list: p.read
      .input(
        z
          .object({
            customerId: z.uuid().optional(),
            parentAccountId: z.uuid().optional(),
            commercialStatus: z.enum(COMMERCIAL_STATUSES).optional(),
            serviceStatus: z.enum(SERVICE_STATES).optional(),
            /** Accounts with a service point in this area (scheme, zone, sub-zone or DMA), or below it. */
            areaId: z.uuid().optional(),
            /** Accounts with a service point on this route, or on a route below it. */
            routeId: z.uuid().optional(),
            after: Number_.optional(),
            limit: Page,
          })
          .optional(),
      )
      .query(async ({ ctx, input }) => {
        const placed = [];
        if (input?.areaId) {
          const ids = [...(await descendantsOf(ctx.tx, "area", input.areaId))];
          placed.push(or(inArray(servicePoint.schemeId, ids), inArray(servicePoint.zoneId, ids), inArray(servicePoint.dmaId, ids)));
        }
        if (input?.routeId) placed.push(inArray(servicePoint.routeId, [...(await descendantsOf(ctx.tx, "route", input.routeId))]));
        const rows = await ctx.tx
          .select()
          .from(account)
          .where(
            and(
              accountVisible(ctx.viewer),
              input?.customerId ? eq(account.customerId, input.customerId) : undefined,
              input?.parentAccountId ? eq(account.parentAccountId, input.parentAccountId) : undefined,
              input?.commercialStatus ? eq(account.commercialStatus, input.commercialStatus) : undefined,
              input?.serviceStatus ? eq(account.serviceStatus, input.serviceStatus) : undefined,
              placed.length
                ? sql`exists (select 1 from ${servicePoint} where ${servicePoint.accountId} = ${account.id} and ${and(...placed)})`
                : undefined,
              input?.after ? sql`${account.number} > ${input.after.trim().toUpperCase()}` : undefined,
            ),
          )
          .orderBy(asc(account.number))
          .limit(input?.limit ?? 50);
        return presentAccounts(ctx.tx, rows);
      }),

    /** By account number (prefix), customer name, or phone in any spelling. */
    search: p.read.input(z.object({ q: z.string().trim().min(1).max(100), limit: z.number().int().min(1).max(100).default(25) })).query(async ({ ctx, input }) => {
      const q = input.q;
      const upper = q.toUpperCase();
      const conditions = [sql`${account.number} like ${`${likeEscape(upper)}%`}`, ilike(customer.name, `%${likeEscape(q)}%`)];
      const digits = q.replace(/\D/g, "").replace(/^0+/, "");
      if (digits.length >= 4 && /^[\d\s\-+().]+$/.test(q)) {
        const parsed = parsePhone(q, await callingCodeFor(ctx.tx));
        conditions.push(
          inArray(
            account.customerId,
            ctx.tx
              .select({ id: customerContact.customerId })
              .from(customerContact)
              .where(
                and(
                  eq(customerContact.channel, "phone"),
                  parsed.kind === "valid" ? eq(customerContact.normalized, parsed.digits) : sql`${customerContact.normalized} like ${`%${digits}%`}`,
                ),
              ),
          ),
        );
      }
      const rows = await ctx.tx
        .select({ account })
        .from(account)
        .innerJoin(customer, and(eq(customer.organizationId, account.organizationId), eq(customer.id, account.customerId)))
        .where(and(or(...conditions), accountVisible(ctx.viewer)))
        .orderBy(sql`(${account.number} = ${upper}) desc`, asc(account.number))
        .limit(input.limit);
      return presentAccounts(
        ctx.tx,
        rows.map((r) => r.account),
      );
    }),

    /**
     * The number the next account would get, for the form before it is saved (C-02). Not a
     * reservation: another create may take it first. With `parentAccountId`, the next child
     * letter under that top-level account.
     */
    nextNumberPreview: p.read.input(z.object({ parentAccountId: z.uuid().optional() }).optional()).query(async ({ ctx, input }) => {
      const format = await ctx.config(numberingSetting);
      let next: string;
      if (input?.parentAccountId) {
        const parent = await findAccount(ctx.tx, ctx.viewer, { id: input.parentAccountId });
        if (parent.parentAccountId !== null) throw new TRPCError({ code: "BAD_REQUEST", message: "Only a top-level account's number takes letters" });
        next = await previewNextNumber(ctx.tx, format, parent);
      } else {
        next = await previewNextNumber(ctx.tx, format);
      }
      return { next, format };
    }),
  };
}
