import { CHARGE_TYPES, COMMERCIAL_STATUSES, DEFAULT_STATUS_RULES, SERVICE_STATES, statusRuleCellSchema, statusRulesSchema, type ChargeType, type CommercialStatus, type ServiceState, type StatusRuleCell, type StatusRules } from "@flowless/shared-types";

// The schemas are shared with the web form (`@flowless/shared-types`); the module keeps exporting them.
export { DEFAULT_STATUS_RULES, statusRuleCellSchema, statusRulesSchema, type StatusRuleCell, type StatusRules };

/*
 * Status-by-charge rules (C-04), pure: for each commercial status and service status, whether
 * consumption is billed and which charge types apply. It is configuration per organization
 * (`accounts.status_rules`), and `chargesApplying` is the published interface Billing reads
 * in Phase 4. It refers to the shared charge type list only, never to Tariffs' tables or
 * charge items: Billing intersects a charge item's type with this answer.
 */

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
