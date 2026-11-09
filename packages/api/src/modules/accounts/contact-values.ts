import type { Transaction } from "@flowless/db";
import { customerContact } from "@flowless/db/schema/accounts";
import { callingCodeOf, parsePhone, type ContactChannel } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { asc, inArray } from "drizzle-orm";
import { z } from "zod";
import { readSetting } from "../../kernel/config-store";
import { regionalSetting } from "../../kernel/regional";

/*
 * What a contact is (C-01): how a typed value is normalised, how contacts are read, and the
 * phone or email to reach a customer on. No writes and no lookups of customers, so the row
 * presenters in `service.ts` can use it; the use cases that change contacts are `contacts.ts`.
 */

export type ContactRow = typeof customerContact.$inferSelect;

const emailSchema = z.email();

/** The organization's calling code, from the language and region it has configured (NF-33). */
export async function callingCodeFor(tx: Transaction): Promise<string> {
  return callingCodeOf((await readSetting(tx, regionalSetting)).value.locale);
}

export interface ContactFields {
  value: string;
  normalized: string | null;
  isPlaceholder: boolean;
}

/**
 * What to store for a contact (C-01). A placeholder phone (25400000000, 0777777777 ...) is
 * kept as typed, flagged, and counts as no phone; anything else that is not a phone or an
 * email is refused.
 */
export function contactFields(channel: ContactChannel, rawValue: string, callingCode: string): ContactFields {
  const value = rawValue.trim();
  if (channel === "email") {
    const parsed = emailSchema.safeParse(value);
    if (!parsed.success) throw new TRPCError({ code: "BAD_REQUEST", message: "That is not a valid email address" });
    return { value, normalized: value.toLowerCase(), isPlaceholder: false };
  }
  const phone = parsePhone(value, callingCode);
  if (phone.kind === "invalid") throw new TRPCError({ code: "BAD_REQUEST", message: phone.reason });
  if (phone.kind === "placeholder") return { value, normalized: null, isPlaceholder: true };
  return { value, normalized: phone.digits, isPlaceholder: false };
}

export async function contactsOf(tx: Transaction, customerIds: readonly string[]): Promise<ContactRow[]> {
  if (customerIds.length === 0) return [];
  return tx
    .select()
    .from(customerContact)
    .where(inArray(customerContact.customerId, [...customerIds]))
    .orderBy(asc(customerContact.createdAt), asc(customerContact.id));
}

/** The number to reach a customer on: the primary phone, else the oldest real one. Never a placeholder. */
export function usablePhone(contacts: readonly ContactRow[]): string | null {
  const phones = contacts.filter((c) => c.channel === "phone" && c.normalized !== null);
  return (phones.find((c) => c.isPrimary) ?? phones[0])?.normalized ?? null;
}

export function usableEmail(contacts: readonly ContactRow[]): string | null {
  const emails = contacts.filter((c) => c.channel === "email" && c.normalized !== null);
  return (emails.find((c) => c.isPrimary) ?? emails[0])?.normalized ?? null;
}

export function toContactDto(c: ContactRow) {
  return {
    id: c.id,
    customerId: c.customerId,
    channel: c.channel,
    kind: c.kind,
    value: c.value,
    /** 254-format digits for a phone, lower-case address for an email; null for a placeholder. */
    normalized: c.normalized,
    isPlaceholder: c.isPlaceholder,
    isPrimary: c.isPrimary,
    createdAt: c.createdAt,
  };
}
export type ContactDto = ReturnType<typeof toContactDto>;
