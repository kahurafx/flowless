import type { Money } from "./money";

/**
 * Commercial status (C-03), in the order an account normally moves through them. The
 * `accounts.account` check constraint is built from this list, so a new value needs a
 * migration. Transitions are the account lifecycle (Phase 3 F3), not defined here.
 */
export const COMMERCIAL_STATUSES = ["NEW", "PENDING_PAYMENT", "ACTIVE", "DORMANT", "TERMINATED"] as const;
export type CommercialStatus = (typeof COMMERCIAL_STATUSES)[number];

/**
 * What can be done to an account's status (C-03). Every status change is one logged command
 * (`accounts.account_command`), and its check constraint is built from this list, so a new
 * kind needs a migration. `write_off_decided` records an approval's outcome (C-11) and
 * changes no status.
 */
export const ACCOUNT_COMMAND_KINDS = [
  "activate",
  "mark_pending_payment",
  "make_dormant",
  "reactivate",
  "terminate",
  "disconnect_service",
  "reconnect_service",
  "write_off_decided",
] as const;
export type AccountCommandKind = (typeof ACCOUNT_COMMAND_KINDS)[number];

/** The activation gates Flowless knows (C-06); an organization can add office checklist items of its own. */
export const ACTIVATION_GATE_KEYS = ["payment_threshold", "meter_installed", "initial_reading"] as const;
export type ActivationGateKey = (typeof ACTIVATION_GATE_KEYS)[number];

/** Activation happens by itself once the gates are met, or when the office activates from the checklist (C-06). */
export const ACTIVATION_MODES = ["auto", "checklist"] as const;
export type ActivationMode = (typeof ACTIVATION_MODES)[number];

/** Ticking an office checklist item, and taking the tick back (a retraction row; history is never edited). */
export const ACTIVATION_CHECK_ACTIONS = ["tick", "untick"] as const;
export type ActivationCheckAction = (typeof ACTIVATION_CHECK_ACTIONS)[number];

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
