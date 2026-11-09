import { defineSetting } from "../../kernel/config-store";
import { activationConfigSchema, type ActivationConfig } from "./gates";
import { DEFAULT_NUMBERING, numberingFormatSchema } from "./numbering";
import { DEFAULT_STATUS_RULES, statusRulesSchema, type StatusRules } from "./status-rules";

/**
 * How this organization numbers accounts (C-02, NF-32): prefix, digits, check-digit scheme,
 * separator and the child-letter style. Behaviour is configuration, never per-tenant code.
 * A change applies to numbers issued from then on; issued numbers are never rewritten, and
 * the sequence counter only moves forward (raising `start` skips ahead).
 */
export const numberingSetting = defineSetting({
  key: "accounts.numbering",
  module: "accounts",
  label: "Account numbers",
  description:
    "The format of new account numbers: an optional prefix, the sequence padded to a width, a check digit (none, luhn or mod11) and a separator. Child accounts add letters to their parent's number.",
  schema: numberingFormatSchema,
  default: DEFAULT_NUMBERING,
});

/**
 * What is billed in each commercial and service status (C-04): whether consumption is
 * billed and which charge types apply. Billing reads it through `chargesApplying`.
 */
export const statusRulesSetting = defineSetting<StatusRules>({
  key: "accounts.status_rules",
  module: "accounts",
  label: "Charges by account status",
  description:
    "For each commercial status (new, pending payment, active, dormant, terminated) and service status (connected, disconnected): whether consumption is billed and which charge types (usage, recurring, fee, penalty, deposit, material, labour, transfer, adjustment) apply.",
  schema: statusRulesSchema,
  default: statusRulesSchema.parse(DEFAULT_STATUS_RULES),
});

/**
 * How accounts are activated (C-06): automatically or from the office checklist, which gates
 * apply and which are required, the office's own checklist items, and how long an account may
 * wait in NEW or PENDING_PAYMENT before it is raised as stale.
 */
export const activationSetting = defineSetting<ActivationConfig>({
  key: "accounts.activation",
  module: "accounts",
  label: "Account activation",
  description:
    "Whether accounts activate by themselves once their gates are met or from the office checklist; the gates (payment threshold, meter installed and confirmed, initial reading) with whether each is used and required; the office's own checklist items; and the days after which an account stuck in new or pending payment is raised in the exception queue.",
  schema: activationConfigSchema,
  default: activationConfigSchema.parse(undefined),
});
