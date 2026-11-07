import type { Money } from "./money";

/** Commercial status (C-03). */
export type CommercialStatus = "NEW" | "PENDING_PAYMENT" | "ACTIVE" | "DORMANT" | "TERMINATED";

/** Service status, a separate axis from commercial status (C-03). */
export type ServiceStatus = { state: "CONNECTED" } | { state: "DISCONNECTED"; reason: string };

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

/** C-01: placeholder numbers are treated as no phone. */
export function normalizePhone(raw: string | null | undefined): string | null {
  const phone = raw?.replace(/[\s-]/g, "") ?? "";
  return phone === "" || PLACEHOLDER_PHONE.test(phone) ? null : phone;
}
