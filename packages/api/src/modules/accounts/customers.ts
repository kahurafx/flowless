import type { Transaction } from "@flowless/db";
import { account, customer, customerContact } from "@flowless/db/schema/accounts";
import { CONTACT_CHANNELS, CONTACT_KINDS, CUSTOMER_TYPES, parsePhone } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { EventDef } from "../../kernel/events";
import type { AuditNote } from "../../trpc";
import { router } from "../../trpc";
import { accountVisible, customerVisible } from "./access";
import { customerCreated } from "./events";
import type { AccountsProcedures } from "./procedures";
import {
  callingCodeFor,
  contactFields,
  contactsOf,
  findCustomer,
  findDuplicates,
  insertContact,
  likeEscape,
  normalizeIdNumber,
  notFound,
  presentAccounts,
  presentCustomers,
  promoteNextPrimary,
  tidy,
  toContactDto,
  toCustomerDto,
  type CustomerDto,
} from "./service";

const Name = z.string().trim().min(1).max(200);
const IdNumber = z.string().trim().min(1).max(40);
const Language = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Use a language code such as en, sw or en-KE");
const Notes = z.string().max(4000);

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
    add: p.update.input(z.object({ customerId: z.uuid() }).extend(ContactInput.shape)).mutation(async ({ ctx, input }) => {
      await findCustomer(ctx.tx, ctx.viewer, input.customerId, true);
      const fields = contactFields(input.channel, input.value, await callingCodeFor(ctx.tx));
      const row = await insertContact(ctx.tx, {
        organizationId: ctx.organizationId,
        userId: ctx.viewer.userId,
        customerId: input.customerId,
        channel: input.channel,
        kind: input.kind,
        fields,
        isPrimary: input.isPrimary,
      });
      await ctx.audit({
        action: "accounts.contact_add",
        subjectType: "customer",
        subjectId: input.customerId,
        after: { contactId: row.id, channel: row.channel, kind: row.kind, value: row.value, isPlaceholder: row.isPlaceholder, isPrimary: row.isPrimary },
      });
      return toContactDto(row);
    }),

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
      .mutation(async ({ ctx, input }) => {
        const [found] = await ctx.tx.select().from(customerContact).where(eq(customerContact.id, input.id));
        if (!found) throw notFound("Contact");
        await findCustomer(ctx.tx, ctx.viewer, found.customerId, true);
        const [before] = await ctx.tx.select().from(customerContact).where(eq(customerContact.id, input.id));
        if (!before) throw notFound("Contact");

        const { value, kind, isPrimary } = input.patch;
        const fields = value !== undefined ? contactFields(before.channel, value, await callingCodeFor(ctx.tx)) : null;
        const becomesPlaceholder = fields?.isPlaceholder ?? before.isPlaceholder;
        if (isPrimary && becomesPlaceholder) throw new TRPCError({ code: "BAD_REQUEST", message: "A placeholder number cannot be the primary phone" });

        const wantsPrimary = becomesPlaceholder ? false : (isPrimary ?? before.isPrimary);
        if (wantsPrimary && !before.isPrimary) {
          await ctx.tx
            .update(customerContact)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(and(eq(customerContact.customerId, before.customerId), eq(customerContact.channel, before.channel), eq(customerContact.isPrimary, true)));
        }
        const [row] = await ctx.tx
          .update(customerContact)
          .set({
            ...(fields ? { value: fields.value, normalized: fields.normalized, isPlaceholder: fields.isPlaceholder } : {}),
            ...(kind !== undefined ? { kind } : {}),
            // Demoting the only primary hands the role to the oldest real contact below.
            isPrimary: wantsPrimary,
            updatedAt: new Date(),
          })
          .where(eq(customerContact.id, before.id))
          .returning();
        await promoteNextPrimary(ctx.tx, before.customerId, before.channel);
        const [after] = await ctx.tx.select().from(customerContact).where(eq(customerContact.id, before.id));
        const was = { value: before.value, kind: before.kind, isPlaceholder: before.isPlaceholder, isPrimary: before.isPrimary };
        const now = { value: row!.value, kind: row!.kind, isPlaceholder: row!.isPlaceholder, isPrimary: after!.isPrimary };
        if (JSON.stringify(was) !== JSON.stringify(now)) {
          await ctx.audit({ action: "accounts.contact_update", subjectType: "customer", subjectId: before.customerId, before: { contactId: before.id, ...was }, after: { contactId: before.id, ...now } });
        }
        return toContactDto(after!);
      }),

    remove: p.update.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
      const [found] = await ctx.tx.select().from(customerContact).where(eq(customerContact.id, input.id));
      if (!found) throw notFound("Contact");
      await findCustomer(ctx.tx, ctx.viewer, found.customerId, true);
      await ctx.tx.delete(customerContact).where(eq(customerContact.id, found.id));
      await promoteNextPrimary(ctx.tx, found.customerId, found.channel);
      await ctx.audit({
        action: "accounts.contact_remove",
        subjectType: "customer",
        subjectId: found.customerId,
        before: { contactId: found.id, channel: found.channel, kind: found.kind, value: found.value, isPlaceholder: found.isPlaceholder, isPrimary: found.isPrimary },
      });
      return { id: found.id };
    }),
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

/** Where a customer is created from: a procedure, or another use case (an application, a succession) in its caller's transaction. */
export interface CustomerEnv {
  tx: Transaction;
  organizationId: string;
  userId: string;
  audit(note: AuditNote): Promise<void>;
  publish<T>(event: EventDef<T>, payload: T): Promise<unknown>;
}

/** Creates a customer with its contacts, audited and announced (C-01). */
export async function createCustomer(env: CustomerEnv, input: NewCustomer) {
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
      createdByUserId: env.userId,
    })
    .returning();
  for (const c of prepared) {
    await insertContact(env.tx, {
      organizationId: env.organizationId,
      userId: env.userId,
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
    createdByUserId: env.userId,
  });
  return { ...dto, contacts: contacts.map(toContactDto) };
}

/** Customers (C-01). */
export function customersRouter(p: AccountsProcedures) {
  return router({
    create: p.create.input(NewCustomerInput).mutation(({ ctx, input }) => createCustomer({ ...ctx, userId: ctx.viewer.userId }, input)),

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
