import type { Transaction } from "@flowless/db";
import { customer, customerContact } from "@flowless/db/schema/accounts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { customerVisible, type Viewer } from "./access";
import { presentCustomers } from "./service";

export type DuplicateMatch = "phone" | "national_id" | "registration_number";

/**
 * Customers that may be the same person or company (C-01): the same normalised phone, the
 * same national id or the same registration number. A warning for the clerk, never a block.
 * Only customers the viewer may see are returned.
 */
export async function findDuplicates(
  tx: Transaction,
  viewer: Viewer,
  query: { phones: readonly string[]; nationalId: string | null; registrationNumber: string | null; excludeCustomerId?: string },
) {
  const matches = new Map<string, Set<DuplicateMatch>>();
  const note = (id: string, how: DuplicateMatch) => {
    if (id === query.excludeCustomerId) return;
    matches.set(id, (matches.get(id) ?? new Set()).add(how));
  };
  const visible = customerVisible(viewer);
  if (query.nationalId) {
    const rows = await tx
      .select({ id: customer.id })
      .from(customer)
      .where(and(eq(customer.nationalId, query.nationalId), visible));
    for (const r of rows) note(r.id, "national_id");
  }
  if (query.registrationNumber) {
    const rows = await tx
      .select({ id: customer.id })
      .from(customer)
      .where(and(eq(customer.registrationNumber, query.registrationNumber), visible));
    for (const r of rows) note(r.id, "registration_number");
  }
  if (query.phones.length) {
    const rows = await tx
      .selectDistinct({ id: customer.id })
      .from(customerContact)
      .innerJoin(customer, and(eq(customer.organizationId, customerContact.organizationId), eq(customer.id, customerContact.customerId)))
      .where(and(eq(customerContact.channel, "phone"), inArray(customerContact.normalized, [...query.phones]), visible));
    for (const r of rows) note(r.id, "phone");
  }
  if (matches.size === 0) return [];
  const rows = await tx
    .select()
    .from(customer)
    .where(inArray(customer.id, [...matches.keys()]))
    .orderBy(asc(customer.name), asc(customer.id))
    .limit(50);
  const dtos = await presentCustomers(tx, rows);
  return dtos.map((c) => ({ customer: c, matchedOn: [...matches.get(c.id)!].sort() }));
}
