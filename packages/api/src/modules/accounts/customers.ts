import { account, customer, customerContact } from "@flowless/db/schema/accounts";
import { CONTACT_CHANNELS, CONTACT_KINDS, CUSTOMER_TYPES, parsePhone } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { procedureEnv, type UserActionEnv } from "../../kernel/action-env";
import { router } from "../../trpc";
import { accountVisible, customerVisible } from "./access";
import { customerCreated } from "./events";
import type { AccountsProcedures } from "./procedures";
import { notFound } from "../../kernel/errors";
import { likeEscape, tidy } from "../../kernel/text";
import { callingCodeFor, contactFields, contactsOf, toContactDto } from "./contact-values";
import { addContact, insertContact, removeContact, updateContact } from "./contacts";
import { findDuplicates } from "./duplicates";
import { findCustomer, presentAccounts, presentCustomers, toCustomerDto, type CustomerDto } from "./service";

const Name = z.string().trim().min(1).max(200);
const IdNumber = z.string().trim().min(1).max(40);
const Language = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Use a language code such as en, sw or en-KE");
const Notes = z.string().max(4000);

/** National ids and registration numbers are compared without spaces, dots or dashes, in upper case. */
function normalizeIdNumber(raw: string | null | undefined): string | null {
  const id = (raw ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return id === "" ? null : id;
}

const ContactInput = z.object({
  channel: z.enum(CONTACT_CHANNELS),
  value: z.string().trim().min(1).max(200),
  kind: z.enum(CONTACT_KINDS).default("personal"),
  isPrimary: z.boolean().default(false),
});

/** What the audit log keeps of a customer: the facts, not the timestamps. */
const audited = (c: CustomerDto) => ({
  type: c.type,
  name: c.name,
  nationalId: c.nationalId,
  registrationNumber: c.registrationNumber,
  language: c.language,
  notes: c.notes,
});

function assertIdentityFits(type: (typeof CUSTOMER_TYPES)[number], nationalId: string | null | undefined, registrationNumber: string | null | undefined) {
  if (type === "organization" && nationalId) throw new TRPCError({ code: "BAD_REQUEST", message: "An organization has a registration number, not a national id" });
  if (type === "person" && registrationNumber) throw new TRPCError({ code: "BAD_REQUEST", message: "A person has a national id, not a registration number" });
}

/** Contact management (C-01): `contacts.*`. Changing contacts is changing the customer, so it needs `accounts:update`. */
export function contactsRouter(p: AccountsProcedures) {
  return router({
    add: p.update
      .input(z.object({ customerId: z.uuid() }).extend(ContactInput.shape))
      .mutation(({ ctx, input }) => addContact(procedureEnv(ctx), ctx.viewer, input)),

    update: p.update
      .input(
        z.object({
          id: z.uuid(),
          patch: z
            .object({ value: z.string().trim().min(1).max(200), kind: z.enum(CONTACT_KINDS), isPrimary: z.boolean() })
            .partial()
            .refine((patch) => Object.values(patch).some((v) => v !== undefined), "Patch is empty"),
        }),
      )
      .mutation(({ ctx, input }) => updateContact(procedureEnv(ctx), ctx.viewer, input.id, input.patch)),

    remove: p.update.input(z.object({ id: z.uuid() })).mutation(({ ctx, input }) => removeContact(procedureEnv(ctx), ctx.viewer, input.id)),
  });
}

/** What it takes to create a customer (C-01): the identity and any contacts. */
export const NewCustomerInput = z.object({
  type: z.enum(CUSTOMER_TYPES),
  name: Name,
  nationalId: IdNumber.optional(),
  registrationNumber: IdNumber.optional(),
  language: Language.optional(),
  notes: Notes.optional(),
  contacts: z.array(ContactInput).max(10).default([]),
});
export type NewCustomer = z.infer<typeof NewCustomerInput>;

/** Creates a customer with its contacts, audited and announced (C-01). */
export async function createCustomer(env: UserActionEnv, input: NewCustomer) {
  assertIdentityFits(input.type, input.nationalId, input.registrationNumber);
  const code = await callingCodeFor(env.tx);
  const prepared = input.contacts.map((c) => ({ ...c, fields: contactFields(c.channel, c.value, code) }));
  const [row] = await env.tx
    .insert(customer)
    .values({
      organizationId: env.organizationId,
      type: input.type,
      name: tidy(input.name),
      nationalId: normalizeIdNumber(input.nationalId),
      registrationNumber: normalizeIdNumber(input.registrationNumber),
      language: input.language ?? null,
      notes: input.notes ?? null,
      createdByUserId: env.actor.userId,
    })
    .returning();
  for (const c of prepared) {
    await insertContact(env.tx, {
      organizationId: env.organizationId,
      userId: env.actor.userId,
      customerId: row!.id,
      channel: c.channel,
      kind: c.kind,
      fields: c.fields,
      isPrimary: c.isPrimary,
    });
  }
  const contacts = await contactsOf(env.tx, [row!.id]);
  const dto = toCustomerDto(row!, contacts);
  await env.audit({
    action: "accounts.customer_create",
    subjectType: "customer",
    subjectId: row!.id,
    after: { ...audited(dto), contacts: contacts.map((c) => ({ channel: c.channel, value: c.value, isPlaceholder: c.isPlaceholder, isPrimary: c.isPrimary })) },
  });
  await env.publish(customerCreated, {
    customerId: row!.id,
    type: row!.type,
    reachableBy: [...new Set(contacts.filter((c) => c.normalized !== null).map((c) => c.channel))],
    createdByUserId: env.actor.userId,
  });
  return { ...dto, contacts: contacts.map(toContactDto) };
}

/** Customers (C-01). */
export function customersRouter(p: AccountsProcedures) {
  return router({
    create: p.create.input(NewCustomerInput).mutation(({ ctx, input }) => createCustomer(procedureEnv(ctx), input)),

    update: p.update
      .input(
        z.object({
          id: z.uuid(),
          patch: z
            .object({
              name: Name,
              nationalId: IdNumber.nullable(),
              registrationNumber: IdNumber.nullable(),
              language: Language.nullable(),
              notes: Notes.nullable(),
            })
            .partial()
            .refine((patch) => Object.values(patch).some((v) => v !== undefined), "Patch is empty"),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const before = await findCustomer(ctx.tx, ctx.viewer, input.id, true);
        const { patch } = input;
        assertIdentityFits(before.type, patch.nationalId, patch.registrationNumber);
        const next = {
          name: patch.name !== undefined ? tidy(patch.name) : before.name,
          nationalId: patch.nationalId !== undefined ? normalizeIdNumber(patch.nationalId) : before.nationalId,
          registrationNumber: patch.registrationNumber !== undefined ? normalizeIdNumber(patch.registrationNumber) : before.registrationNumber,
          language: patch.language !== undefined ? patch.language : before.language,
          notes: patch.notes !== undefined ? patch.notes : before.notes,
        };
        const contacts = await contactsOf(ctx.tx, [before.id]);
        const was = audited(toCustomerDto(before, contacts));
        if (JSON.stringify(was) === JSON.stringify({ type: before.type, ...next })) return toCustomerDto(before, contacts);
        const [row] = await ctx.tx.update(customer).set({ ...next, updatedAt: new Date() }).where(eq(customer.id, before.id)).returning();
        const dto = toCustomerDto(row!, contacts);
        await ctx.audit({ action: "accounts.customer_update", subjectType: "customer", subjectId: before.id, before: was, after: audited(dto) });
        return dto;
      }),

    get: p.read.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
      const row = await findCustomer(ctx.tx, ctx.viewer, input.id);
      const contacts = await contactsOf(ctx.tx, [row.id]);
      const accounts = await ctx.tx
        .select()
        .from(account)
        .where(and(eq(account.customerId, row.id), accountVisible(ctx.viewer)))
        .orderBy(asc(account.number));
      return { ...toCustomerDto(row, contacts), contacts: contacts.map(toContactDto), accounts: await presentAccounts(ctx.tx, accounts) };
    }),

    /** Name order; pass the last id of a page as `after` for the next one. */
    list: p.read
      .input(z.object({ type: z.enum(CUSTOMER_TYPES).optional(), after: z.uuid().optional(), limit: z.number().int().min(1).max(200).default(50) }).optional())
      .query(async ({ ctx, input }) => {
        let cursor;
        if (input?.after) {
          const [row] = await ctx.tx.select({ name: customer.name, id: customer.id }).from(customer).where(and(eq(customer.id, input.after), customerVisible(ctx.viewer)));
          if (!row) throw notFound("Customer");
          cursor = sql`(lower(${customer.name}), ${customer.id}) > (lower(${row.name}), ${row.id}::uuid)`;
        }
        const rows = await ctx.tx
          .select()
          .from(customer)
          .where(and(customerVisible(ctx.viewer), input?.type ? eq(customer.type, input.type) : undefined, cursor))
          .orderBy(sql`lower(${customer.name})`, asc(customer.id))
          .limit(input?.limit ?? 50);
        return presentCustomers(ctx.tx, rows);
      }),

    /** By name, phone (any spelling), email, national id or registration number. */
    search: p.read.input(z.object({ q: z.string().trim().min(1).max(100), limit: z.number().int().min(1).max(100).default(25) })).query(async ({ ctx, input }) => {
      const q = input.q;
      const idLike = normalizeIdNumber(q);
      const digits = q.replace(/\D/g, "").replace(/^0+/, "");
      const conditions = [ilike(customer.name, `%${likeEscape(q)}%`)];
      if (idLike && idLike.length >= 3) {
        conditions.push(sql`${customer.nationalId} like ${`${likeEscape(idLike)}%`}`, sql`${customer.registrationNumber} like ${`${likeEscape(idLike)}%`}`);
      }
      const contactMatches = [];
      if (digits.length >= 4 && /^[\d\s\-+().]+$/.test(q)) {
        const parsed = parsePhone(q, await callingCodeFor(ctx.tx));
        contactMatches.push(
          and(
            eq(customerContact.channel, "phone"),
            parsed.kind === "valid" ? eq(customerContact.normalized, parsed.digits) : sql`${customerContact.normalized} like ${`%${digits}%`}`,
          ),
        );
      }
      if (q.includes("@")) contactMatches.push(and(eq(customerContact.channel, "email"), ilike(customerContact.normalized, `${likeEscape(q)}%`)));
      if (contactMatches.length) {
        conditions.push(
          inArray(
            customer.id,
            ctx.tx
              .select({ id: customerContact.customerId })
              .from(customerContact)
              .where(or(...contactMatches)),
          ),
        );
      }
      const rows = await ctx.tx
        .select()
        .from(customer)
        .where(and(or(...conditions), customerVisible(ctx.viewer)))
        .orderBy(sql`lower(${customer.name})`, asc(customer.id))
        .limit(input.limit);
      return presentCustomers(ctx.tx, rows);
    }),

    /**
     * Customers who may be the same as this one (C-01): same normalised phone, national id
     * or registration number. Give an existing `customerId`, or what is about to be entered.
     * A warning only; creating the customer is never blocked.
     */
    duplicates: p.read
      .input(
        z
          .object({
            customerId: z.uuid().optional(),
            phone: z.string().trim().min(1).max(40).optional(),
            nationalId: IdNumber.optional(),
            registrationNumber: IdNumber.optional(),
          })
          .refine((q) => Object.values(q).some((v) => v !== undefined), "Give a customer, phone, national id or registration number"),
      )
      .query(async ({ ctx, input }) => {
        const phones = new Set<string>();
        let nationalId = normalizeIdNumber(input.nationalId);
        let registrationNumber = normalizeIdNumber(input.registrationNumber);
        if (input.customerId) {
          const row = await findCustomer(ctx.tx, ctx.viewer, input.customerId);
          nationalId ??= row.nationalId;
          registrationNumber ??= row.registrationNumber;
          for (const c of await contactsOf(ctx.tx, [row.id])) if (c.channel === "phone" && c.normalized) phones.add(c.normalized);
        }
        if (input.phone) {
          const parsed = parsePhone(input.phone, await callingCodeFor(ctx.tx));
          if (parsed.kind === "invalid") throw new TRPCError({ code: "BAD_REQUEST", message: parsed.reason });
          if (parsed.kind === "valid") phones.add(parsed.digits);
        }
        return findDuplicates(ctx.tx, ctx.viewer, { phones: [...phones], nationalId, registrationNumber, excludeCustomerId: input.customerId });
      }),
  });
}
