import { defineSetting } from "../../kernel/config-store";
import { applicationConfigSchema, type ApplicationConfig } from "./application-stages";
import { activationConfigSchema, type ActivationConfig } from "./gates";
import { membershipConfigSchema, type MembershipConfig } from "./membership";
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

/**
 * How applications for new connections run (C-05, K-10): which stages are used (a survey, the
 * new-connection invoice with its payment, installation) and whether a relocation needs a
 * survey. How many people approve a survey (0, 1 or 2 levels) is the K-05 policy
 * `approvals.accounts.connection_survey`.
 */
export const applicationSetting = defineSetting<ApplicationConfig>({
  key: "accounts.application",
  module: "accounts",
  label: "Applications for new connections",
  description:
    "Which stages an application for a new connection goes through (survey, new-connection invoice and payment, installation) and whether a relocation needs a survey. The number of approvals a survey needs is the approval policy accounts.connection_survey.",
  schema: applicationConfigSchema,
  default: applicationConfigSchema.parse({}),
});

/** The membership classes of child accounts and the catalog item priced as each class's connection fee (C-07). */
export const membershipSetting = defineSetting<MembershipConfig>({
  key: "accounts.membership",
  module: "accounts",
  label: "Membership classes",
  description: "Classes a child account can belong to (key, label) and, for each, the code of the charge catalog item used as its connection fee.",
  schema: membershipConfigSchema,
  default: membershipConfigSchema.parse({}),
});
