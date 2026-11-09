import type { DataQualityRuleKey, DataQualitySeverity } from "@flowless/shared-types";

/*
 * View models for the data-quality dashboard (C-12): what each tile says and how it is
 * toned, from the summary and the rule settings. Pure, so the wording and the states
 * (clean, flagged, disabled, waiting on Metering) are tested without a browser.
 */

export type RuleState = "enabled" | "disabled" | "no_source";

export interface SummaryRule {
  key: DataQualityRuleKey;
  label: string;
  severity: DataQualitySeverity;
  state: RuleState;
  count: number | null;
}

export type Tone = "success" | "warning" | "info" | "destructive" | "secondary" | "outline";

export const severityTone: Record<DataQualitySeverity, Tone> = { info: "info", warning: "warning", critical: "destructive" };

export interface RuleTile {
  key: DataQualityRuleKey;
  label: string;
  severity: DataQualitySeverity;
  /** What the tile shows in place of a number when the rule is not running. */
  figure: { kind: "count"; count: number } | { kind: "waiting" } | { kind: "disabled" };
  /** Short words under the figure. */
  caption: string;
  tone: Tone;
  /** Findings can be listed. */
  browsable: boolean;
}

/** One tile per rule: a count toned by its severity (calm when zero), "waiting on Metering" for no source, "disabled" when off. */
export function ruleTiles(rules: readonly SummaryRule[], sourceName: (key: DataQualityRuleKey) => string | null = () => null): RuleTile[] {
  return rules.map((rule) => {
    if (rule.state === "disabled") return { key: rule.key, label: rule.label, severity: rule.severity, figure: { kind: "disabled" }, caption: "Switched off in settings", tone: "outline", browsable: false };
    if (rule.state === "no_source") {
      const source = sourceName(rule.key);
      return {
        key: rule.key,
        label: rule.label,
        severity: rule.severity,
        figure: { kind: "waiting" },
        caption: source ? `Waiting on ${source}` : "Waiting on another module",
        tone: "secondary",
        browsable: false,
      };
    }
    const count = rule.count ?? 0;
    return {
      key: rule.key,
      label: rule.label,
      severity: rule.severity,
      figure: { kind: "count", count },
      caption: count === 0 ? "Nothing flagged" : count === 1 ? "1 account flagged" : `${count.toLocaleString("en")} accounts flagged`,
      tone: count === 0 ? "success" : severityTone[rule.severity],
      browsable: count > 0,
    };
  });
}

/** The module whose data decides a rule that is not Accounts' own, for the "waiting on" line. */
export const ruleSourceLabel = (source: "metering" | null): string | null => (source === "metering" ? "Metering" : null);

export interface CleanHeadline {
  percent: number;
  examined: number;
  flagged: number;
  tone: Tone;
  sentence: string;
}

/** The headline: how much of what was examined is clean, and what to do about the rest. */
export function cleanHeadline(summary: { examined: number; flagged: number; cleanPercent: number }): CleanHeadline {
  const { examined, flagged, cleanPercent } = summary;
  const tone: Tone = examined === 0 || flagged === 0 ? "success" : cleanPercent >= 90 ? "info" : cleanPercent >= 70 ? "warning" : "destructive";
  const sentence =
    examined === 0
      ? "No accounts to examine yet."
      : flagged === 0
        ? `All ${examined.toLocaleString("en")} accounts are clean.`
        : `${flagged.toLocaleString("en")} of ${examined.toLocaleString("en")} accounts ${flagged === 1 ? "has" : "have"} at least one finding.`;
  return { percent: cleanPercent, examined, flagged, tone, sentence };
}

export const duplicateMatchLabel: Record<"national_id" | "registration_number" | "phone", string> = {
  national_id: "Same national id",
  registration_number: "Same registration number",
  phone: "Same phone number",
};

/** A group's key as people read it: phones with a plus, ids as they are. */
export function duplicateKeyText(matchedOn: keyof typeof duplicateMatchLabel, key: string): string {
  return matchedOn === "phone" && !key.startsWith("+") ? `+${key}` : key;
}
