import type { CommercialStatus } from "./accounts";

/**
 * The data-quality rules of Accounts (C-12), a catalogue the API checks accounts against
 * and the dashboards list. The rules are fixed in code; what an organization decides is in
 * the `accounts.data_quality` setting: whether a rule runs, how serious its findings are and
 * whether they are raised in the exception queue (X-02). `defaultSeverity` and
 * `defaultEnabled` apply until the organization sets otherwise; raising exceptions is off
 * by default for every rule.
 */
export const DATA_QUALITY_RULE_KEYS = [
  "account_no_phone",
  "account_no_service_point",
  "account_no_coordinates",
  "active_metered_no_meter",
  "zone_equals_route",
  "duplicate_customers",
  "account_category_missing",
] as const;
export type DataQualityRuleKey = (typeof DATA_QUALITY_RULE_KEYS)[number];

export const DATA_QUALITY_SEVERITIES = ["info", "warning", "critical"] as const;
export type DataQualitySeverity = (typeof DATA_QUALITY_SEVERITIES)[number];

export interface DataQualityRuleDef {
  key: DataQualityRuleKey;
  label: string;
  /** What the rule looks for, for the settings page and the dashboard. */
  description: string;
  /** What one finding means, shown beside an account in the findings list. */
  finding: string;
  defaultSeverity: DataQualitySeverity;
  defaultEnabled: boolean;
  /** Accounts in these commercial statuses are checked; terminated accounts never are. */
  appliesTo: readonly CommercialStatus[];
  /** The module whose data decides the rule, when it is not Accounts' own: with it unlicensed or no source registered the rule is skipped, not failed. */
  source: "metering" | null;
}

const OPEN: readonly CommercialStatus[] = ["NEW", "PENDING_PAYMENT", "ACTIVE", "DORMANT"];
const IN_SERVICE_OR_LATER: readonly CommercialStatus[] = ["PENDING_PAYMENT", "ACTIVE", "DORMANT"];

export const DATA_QUALITY_RULES: readonly DataQualityRuleDef[] = [
  {
    key: "account_no_phone",
    label: "No phone number",
    description: "The account's customer has no real contact phone: none at all, or only placeholders such as 0700000000.",
    finding: "The customer has no usable phone number (none, or only placeholders).",
    defaultSeverity: "warning",
    defaultEnabled: true,
    appliesTo: OPEN,
    source: null,
  },
  {
    key: "account_no_service_point",
    label: "No service point",
    description: "A pending, active or dormant account with no service point, so nothing says where it is.",
    finding: "The account has no service point.",
    defaultSeverity: "warning",
    defaultEnabled: true,
    appliesTo: IN_SERVICE_OR_LATER,
    source: null,
  },
  {
    key: "account_no_coordinates",
    label: "No coordinates",
    description: "A pending, active or dormant account with no service point, or none with a GPS location.",
    finding: "No service point of the account has a GPS location.",
    defaultSeverity: "info",
    defaultEnabled: true,
    appliesTo: IN_SERVICE_OR_LATER,
    source: null,
  },
  {
    key: "active_metered_no_meter",
    label: "Active but no meter",
    description: "An active account that should have a meter and has none. Metering decides, so the rule runs once Metering is licensed and reports it.",
    finding: "The account is active and metered but no meter is installed.",
    defaultSeverity: "critical",
    defaultEnabled: true,
    appliesTo: ["ACTIVE"],
    source: "metering",
  },
  {
    key: "zone_equals_route",
    label: "Zone and route confused",
    description:
      "A service point whose route has the same name as its zone, scheme or DMA, or whose route belongs to an area that is neither the service point's zone, scheme or DMA nor inside or above one of them: route and zone entered in the wrong field.",
    finding: "The route and zone look swapped or mixed up.",
    defaultSeverity: "warning",
    defaultEnabled: true,
    appliesTo: OPEN,
    source: null,
  },
  {
    key: "duplicate_customers",
    label: "Duplicate customers",
    description: "The account's customer shares a normalised phone number, national id or registration number with another customer.",
    finding: "The customer shares a phone number, national id or registration number with another customer.",
    defaultSeverity: "warning",
    defaultEnabled: true,
    appliesTo: OPEN,
    source: null,
  },
  {
    key: "account_category_missing",
    label: "No tariff category",
    description: "A pending, active or dormant account with no category, or (with Tariffs licensed) one that is unknown or deactivated, so it cannot be priced.",
    finding: "The account has no valid tariff category.",
    defaultSeverity: "critical",
    defaultEnabled: true,
    appliesTo: IN_SERVICE_OR_LATER,
    source: null,
  },
];

export const dataQualityRule = (key: DataQualityRuleKey): DataQualityRuleDef => DATA_QUALITY_RULES.find((r) => r.key === key)!;

export function isDataQualityRuleKey(value: string): value is DataQualityRuleKey {
  return (DATA_QUALITY_RULE_KEYS as readonly string[]).includes(value);
}

/** One rule with the organization's settings applied. */
export interface EffectiveDataQualityRule extends DataQualityRuleDef {
  enabled: boolean;
  severity: DataQualitySeverity;
  raiseExceptions: boolean;
}

/** What an organization may set per rule; any field left out keeps the catalogue default. */
export interface DataQualityRuleSettings {
  enabled?: boolean | undefined;
  severity?: DataQualitySeverity | undefined;
  raiseExceptions?: boolean | undefined;
}

/**
 * The catalogue with an organization's settings applied. Pure. Keys the catalogue no longer
 * knows are ignored, so an old stored version still reads.
 */
export function effectiveDataQualityRules(settings: Readonly<Record<string, DataQualityRuleSettings | undefined>> = {}): EffectiveDataQualityRule[] {
  return DATA_QUALITY_RULES.map((rule) => {
    const set = settings[rule.key];
    return {
      ...rule,
      enabled: set?.enabled ?? rule.defaultEnabled,
      severity: set?.severity ?? rule.defaultSeverity,
      raiseExceptions: set?.raiseExceptions ?? false,
    };
  });
}

/** Share of examined accounts with no finding, one decimal; 100 when nothing was examined. */
export function cleanPercent(examined: number, flagged: number): number {
  if (examined <= 0) return 100;
  return Math.round(((examined - flagged) / examined) * 1000) / 10;
}
