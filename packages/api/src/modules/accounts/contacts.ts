import type { Transaction } from "@flowless/db";
import { customerContact } from "@flowless/db/schema/accounts";
import type { ContactChannel } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import type { UserActionEnv } from "../../kernel/action-env";
import { notFound } from "../../kernel/errors";
import type { Viewer } from "./access";
import { callingCodeFor, contactFields, toContactDto, type ContactFields, type ContactRow } from "./contact-values";
import { findCustomer } from "./service";

/*
 * Changing a customer's contacts (C-01): `addContact`, `updateContact` and `removeContact`
 * lock the customer, keep exactly one primary real contact per channel, and audit. Changing
 * contacts is changing the customer. How a value is normalised and read is `contact-values.ts`.
 */

const PLACEHOLDER_PRIMARY = "A placeholder number cannot be the primary phone";

/** Adds a contact. The first real one of a channel becomes primary; choosing another primary demotes the old one. */
export async function insertContact(
  tx: Transaction,
  args: {
    organizationId: string;
    userId: string;
    customerId: string;
    channel: ContactChannel;
    kind: ContactRow["kind"];
    fields: ContactFields;
    isPrimary: boolean;
  },
): Promise<ContactRow> {
  const { fields } = args;
  if (args.isPrimary && fields.isPlaceholder) {
    throw new TRPCError({ code: "BAD_REQUEST", message: PLACEHOLDER_PRIMARY });
  }
  let primary = false;
  if (!fields.isPlaceholder) {
    const existing = await tx
      .select({ id: customerContact.id, isPrimary: customerContact.isPrimary })
      .from(customerContact)
      .where(and(eq(customerContact.customerId, args.customerId), eq(customerContact.channel, args.channel), sql`${customerContact.normalized} is not null`));
    primary = args.isPrimary || !existing.some((c) => c.isPrimary);
    if (primary && existing.some((c) => c.isPrimary)) {
      await tx
        .update(customerContact)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(and(eq(customerContact.customerId, args.customerId), eq(customerContact.channel, args.channel), eq(customerContact.isPrimary, true)));
    }
  }
  const [row] = await tx
    .insert(customerContact)
    .values({
      organizationId: args.organizationId,
      customerId: args.customerId,
      channel: args.channel,
      kind: args.kind,
      value: fields.value,
      normalized: fields.normalized,
      isPlaceholder: fields.isPlaceholder,
      isPrimary: primary,
      // Contacts of one request keep the order they were given in (a transaction's now() is one instant).
      createdAt: sql`clock_timestamp()`,
      createdByUserId: args.userId,
    })
    .returning();
  return row!;
}

/** After the primary contact of a channel is removed or becomes a placeholder, the oldest real one takes over. */
async function promoteNextPrimary(tx: Transaction, customerId: string, channel: ContactChannel): Promise<void> {
  const rows = await tx
    .select({ id: customerContact.id, isPrimary: customerContact.isPrimary })
    .from(customerContact)
    .where(and(eq(customerContact.customerId, customerId), eq(customerContact.channel, channel), sql`${customerContact.normalized} is not null`))
    .orderBy(asc(customerContact.createdAt), asc(customerContact.id));
  if (rows.length === 0 || rows.some((r) => r.isPrimary)) return;
  await tx.update(customerContact).set({ isPrimary: true, updatedAt: new Date() }).where(eq(customerContact.id, rows[0]!.id));
}

/** What the audit log keeps of a contact that changes. */
const changing = (c: ContactRow) => ({ value: c.value, kind: c.kind, isPlaceholder: c.isPlaceholder, isPrimary: c.isPrimary });
/** What it keeps of a contact that is added or removed. */
const whole = (c: ContactRow) => ({ contactId: c.id, channel: c.channel, kind: c.kind, value: c.value, isPlaceholder: c.isPlaceholder, isPrimary: c.isPrimary });

export interface NewContact {
  customerId: string;
  channel: ContactChannel;
  value: string;
  kind: ContactRow["kind"];
  isPrimary: boolean;
}

export async function addContact(env: UserActionEnv, viewer: Viewer, input: NewContact) {
  await findCustomer(env.tx, viewer, input.customerId, true);
  const fields = contactFields(input.channel, input.value, await callingCodeFor(env.tx));
  const row = await insertContact(env.tx, {
    organizationId: env.organizationId,
    userId: env.actor.userId,
    customerId: input.customerId,
    channel: input.channel,
    kind: input.kind,
    fields,
    isPrimary: input.isPrimary,
  });
  await env.audit({ action: "accounts.contact_add", subjectType: "customer", subjectId: input.customerId, after: whole(row) });
  return toContactDto(row);
}

export interface ContactPatch {
  value?: string | undefined;
  kind?: ContactRow["kind"] | undefined;
  isPrimary?: boolean | undefined;
}

/** The contact, after its customer is locked (the customer must be visible to the viewer, else NOT_FOUND). */
async function contactOfLockedCustomer(env: UserActionEnv, viewer: Viewer, id: string): Promise<ContactRow> {
  const [row] = await env.tx.select().from(customerContact).where(eq(customerContact.id, id));
  if (!row) throw notFound("Contact");
  await findCustomer(env.tx, viewer, row.customerId, true);
  return row;
}

/**
 * Changes a contact's value, kind or primary flag. Making it primary demotes the old primary;
 * a placeholder is never primary, and when the primary stops being one the oldest real contact
 * of the channel takes over. Audited only when something changed.
 */
export async function updateContact(env: UserActionEnv, viewer: Viewer, id: string, patch: ContactPatch) {
  const before = await contactOfLockedCustomer(env, viewer, id);
  const { value, kind, isPrimary } = patch;
  const fields = value !== undefined ? contactFields(before.channel, value, await callingCodeFor(env.tx)) : null;
  const becomesPlaceholder = fields?.isPlaceholder ?? before.isPlaceholder;
  if (isPrimary && becomesPlaceholder) throw new TRPCError({ code: "BAD_REQUEST", message: PLACEHOLDER_PRIMARY });

  const wantsPrimary = becomesPlaceholder ? false : (isPrimary ?? before.isPrimary);
  if (wantsPrimary && !before.isPrimary) {
    await env.tx
      .update(customerContact)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(and(eq(customerContact.customerId, before.customerId), eq(customerContact.channel, before.channel), eq(customerContact.isPrimary, true)));
  }
  await env.tx
    .update(customerContact)
    .set({
      ...(fields ? { value: fields.value, normalized: fields.normalized, isPlaceholder: fields.isPlaceholder } : {}),
      ...(kind !== undefined ? { kind } : {}),
      // Demoting the only primary hands the role to the oldest real contact below.
      isPrimary: wantsPrimary,
      updatedAt: new Date(),
    })
    .where(eq(customerContact.id, before.id));
  await promoteNextPrimary(env.tx, before.customerId, before.channel);
  const [after] = await env.tx.select().from(customerContact).where(eq(customerContact.id, before.id));
  const was = changing(before);
  const now = changing(after!);
  if (JSON.stringify(was) !== JSON.stringify(now)) {
    await env.audit({ action: "accounts.contact_update", subjectType: "customer", subjectId: before.customerId, before: { contactId: before.id, ...was }, after: { contactId: before.id, ...now } });
  }
  return toContactDto(after!);
}

export async function removeContact(env: UserActionEnv, viewer: Viewer, id: string) {
  const found = await contactOfLockedCustomer(env, viewer, id);
  await env.tx.delete(customerContact).where(eq(customerContact.id, found.id));
  await promoteNextPrimary(env.tx, found.customerId, found.channel);
  await env.audit({ action: "accounts.contact_remove", subjectType: "customer", subjectId: found.customerId, before: whole(found) });
  return { id: found.id };
}
