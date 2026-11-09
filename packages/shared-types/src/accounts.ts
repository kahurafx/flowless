import type { Money } from "./money";

/**
 * Commercial status (C-03), in the order an account normally moves through them. The
 * `accounts.account` check constraint is built from this list, so a new value needs a
 * migration. Transitions are the account lifecycle (Phase 3 F3), not defined here.
 */
export const COMMERCIAL_STATUSES = ["NEW", "PENDING_PAYMENT", "ACTIVE", "DORMANT", "TERMINATED"] as const;
export type CommercialStatus = (typeof COMMERCIAL_STATUSES)[number];

/** The service axis (C-03), separate from commercial status; a disconnection carries a reason. */
export const SERVICE_STATES = ["CONNECTED", "DISCONNECTED"] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

/** Service status, a separate axis from commercial status (C-03). */
export type ServiceStatus = { state: "CONNECTED" } | { state: "DISCONNECTED"; reason: string };

/** Who a customer is (C-01): a person has a national id, an organization a registration number. */
export const CUSTOMER_TYPES = ["person", "organization"] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

/** How a contact reaches the customer (C-01). */
export const CONTACT_CHANNELS = ["phone", "email"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/** What a contact is for, whichever channel it uses. */
export const CONTACT_KINDS = ["personal", "home", "work", "billing", "next_of_kin", "other"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

/** The physical connection's state (glossary: service point). */
export const SERVICE_POINT_STATUSES = ["PLANNED", "CONNECTED", "DISCONNECTED", "DECOMMISSIONED"] as const;
export type ServicePointStatus = (typeof SERVICE_POINT_STATUSES)[number];

/** Account-number check digit schemes (C-02); the algorithms are in `accounts/numbering.ts` in packages/api. */
export const CHECK_DIGIT_SCHEMES = ["none", "luhn", "mod11"] as const;
export type CheckDigitScheme = (typeof CHECK_DIGIT_SCHEMES)[number];

export interface AccountSummary {
  id: string;
  /** Unique per organization, with check digit; may be a child number such as "1008B" (C-02). */
  number: string;
  customerName: string;
  /** Null when missing or a placeholder such as 25400000000 (C-01). */
  phone: string | null;
  category: string;
  zone: string;
  route: string;
  commercialStatus: CommercialStatus;
  service: ServiceStatus;
  /** Derived from ledger entries, never stored in an editable field (I-2). */
  balance: Money;
}

const PLACEHOLDER_PHONE = /^(\+?254|0)0{8,9}$/;

/**
 * C-01: placeholder numbers are treated as no phone. Keeps the number as typed otherwise;
 * `parsePhone` (phone.ts) is the full normaliser to 254 format.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const phone = raw?.replace(/[\s-]/g, "") ?? "";
  return phone === "" || PLACEHOLDER_PHONE.test(phone) ? null : phone;
}
