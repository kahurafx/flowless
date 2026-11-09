import { CHARGE_TYPES, COMMERCIAL_STATUSES, SERVICE_STATES, type ChargeType, type CommercialStatus, type ServiceState } from "@flowless/shared-types";
import { z } from "zod";

/*
 * Status-by-charge rules (C-04), pure: for each commercial status and service status, whether
 * consumption is billed and which charge types apply. It is configuration per organization
 * (`accounts.status_rules`), and `chargesApplying` is the published interface Billing reads
 * in Phase 4. It refers to the shared charge type list only, never to Tariffs' tables or
 * charge items: Billing intersects a charge item's type with this answer.
 */

const chargeType = z.enum(CHARGE_TYPES);

/** One cell of the table. `usage` is billed exactly when consumption is billed. */
export const statusRuleCellSchema = z
  .object({
    billsConsumption: z.boolean().default(false),
    chargeTypes: z
      .array(chargeType)
      .default([])
      .refine((types) => new Set(types).size === types.length, "List each charge type once"),
  })
  .refine((cell) => cell.chargeTypes.includes("usage") === cell.billsConsumption, {
    message: "Usage is billed exactly when consumption is billed",
    path: ["chargeTypes"],
  });
export type StatusRuleCell = z.infer<typeof statusRuleCellSchema>;

const cell = (billsConsumption: boolean, types: readonly ChargeType[]): StatusRuleCell => ({
  billsConsumption,
  chargeTypes: CHARGE_TYPES.filter((t) => types.includes(t)),
});

const rowSchema = (fallback: Record<ServiceState, StatusRuleCell>) =>
  z
    .object({
      CONNECTED: statusRuleCellSchema.default(fallback.CONNECTED),
      DISCONNECTED: statusRuleCellSchema.default(fallback.DISCONNECTED),
    })
    .default(fallback);

const nothing = cell(false, []);
/** A new connection is invoiced before it has service: one-off charges, nothing recurring or metered. */
const oneOff = cell(false, ["fee", "deposit", "material", "labour", "adjustment"]);

export const DEFAULT_STATUS_RULES = {
  NEW: { CONNECTED: oneOff, DISCONNECTED: oneOff },
  PENDING_PAYMENT: { CONNECTED: oneOff, DISCONNECTED: oneOff },
  // Live: everything. Disconnected but active: standing charges and rent still run, consumption does not.
  ACTIVE: {
    CONNECTED: cell(true, CHARGE_TYPES),
    DISCONNECTED: cell(false, CHARGE_TYPES.filter((t) => t !== "usage")),
  },
  // Dormant bills nothing until the organization turns something on.
  DORMANT: { CONNECTED: nothing, DISCONNECTED: nothing },
  // Only what can still follow an account's closing.
  TERMINATED: { CONNECTED: cell(false, ["fee", "penalty", "adjustment"]), DISCONNECTED: cell(false, ["fee", "penalty", "adjustment"]) },
} as const satisfies Record<CommercialStatus, Record<ServiceState, StatusRuleCell>>;

/** Every field has a default, so a stored value from an earlier version still reads (NF-32). */
export const statusRulesSchema = z.object({
  NEW: rowSchema(DEFAULT_STATUS_RULES.NEW),
  PENDING_PAYMENT: rowSchema(DEFAULT_STATUS_RULES.PENDING_PAYMENT),
  ACTIVE: rowSchema(DEFAULT_STATUS_RULES.ACTIVE),
  DORMANT: rowSchema(DEFAULT_STATUS_RULES.DORMANT),
  TERMINATED: rowSchema(DEFAULT_STATUS_RULES.TERMINATED),
});
export type StatusRules = z.infer<typeof statusRulesSchema>;

export interface ChargesApplying {
  /** Is consumption (usage) billed for an account in this state? */
  billsConsumption: boolean;
  /** The charge types that apply, in the shared list's order; `usage` is in it exactly when consumption is billed. */
  chargeTypes: readonly ChargeType[];
}

/** What is billed for an account in this commercial and service status (C-04). */
export function chargesApplying(rules: StatusRules, commercial: CommercialStatus, service: ServiceState): ChargesApplying {
  const found = rules[commercial][service];
  const types = new Set<ChargeType>(found.chargeTypes);
  if (found.billsConsumption) types.add("usage");
  else types.delete("usage");
  return { billsConsumption: found.billsConsumption, chargeTypes: CHARGE_TYPES.filter((t) => types.has(t)) };
}

/** Does a charge of `type` apply to an account in this state? */
export function chargeTypeApplies(rules: StatusRules, commercial: CommercialStatus, service: ServiceState, type: ChargeType): boolean {
  return chargesApplying(rules, commercial, service).chargeTypes.includes(type);
}

/** The whole table as rows (for a screen or a report), in status order. */
export function statusRuleTable(rules: StatusRules) {
  return COMMERCIAL_STATUSES.flatMap((commercial) =>
    SERVICE_STATES.map((service) => ({ commercial, service, ...chargesApplying(rules, commercial, service) })),
  );
}
