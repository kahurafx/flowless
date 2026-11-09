import { describe, expect, it } from "vitest";
import { COMMERCIAL_STATUSES } from "./accounts";
import {
  DATA_QUALITY_RULES,
  DATA_QUALITY_RULE_KEYS,
  DATA_QUALITY_SEVERITIES,
  cleanPercent,
  dataQualityRule,
  effectiveDataQualityRules,
  isDataQualityRuleKey,
} from "./data-quality";

// C-12: the data-quality catalogue.
describe("data-quality catalogue", () => {
  it("has one definition per key, in key order, with unique keys", () => {
    expect(DATA_QUALITY_RULES.map((r) => r.key)).toEqual([...DATA_QUALITY_RULE_KEYS]);
    expect(new Set(DATA_QUALITY_RULES.map((r) => r.key)).size).toBe(DATA_QUALITY_RULES.length);
  });

  it("names every C-12 rule", () => {
    expect(DATA_QUALITY_RULE_KEYS).toEqual(
      expect.arrayContaining(["account_no_phone", "account_no_coordinates", "account_no_service_point", "active_metered_no_meter", "zone_equals_route", "duplicate_customers", "account_category_missing"]),
    );
  });

  it("is well formed: texts, a known severity, statuses that exist and never TERMINATED", () => {
    for (const rule of DATA_QUALITY_RULES) {
      expect(rule.label.length).toBeGreaterThan(0);
      expect(rule.description.length).toBeGreaterThan(10);
      expect(rule.finding.length).toBeGreaterThan(5);
      expect(DATA_QUALITY_SEVERITIES).toContain(rule.defaultSeverity);
      expect(rule.appliesTo.length).toBeGreaterThan(0);
      for (const status of rule.appliesTo) {
        expect(COMMERCIAL_STATUSES).toContain(status);
        expect(status).not.toBe("TERMINATED");
      }
    }
  });

  it("only the meter rule waits on another module", () => {
    expect(DATA_QUALITY_RULES.filter((r) => r.source).map((r) => [r.key, r.source])).toEqual([["active_metered_no_meter", "metering"]]);
  });

  it("looks rules up and recognises keys", () => {
    expect(dataQualityRule("zone_equals_route").label).toMatch(/route/i);
    expect(isDataQualityRuleKey("account_no_phone")).toBe(true);
    expect(isDataQualityRuleKey("nope")).toBe(false);
  });
});

describe("effectiveDataQualityRules", () => {
  it("applies the defaults: everything on, catalogue severity, no exceptions raised", () => {
    const rules = effectiveDataQualityRules();
    expect(rules).toHaveLength(DATA_QUALITY_RULES.length);
    for (const r of rules) {
      expect(r.enabled).toBe(r.defaultEnabled);
      expect(r.severity).toBe(r.defaultSeverity);
      expect(r.raiseExceptions).toBe(false);
    }
  });

  it("applies per-rule overrides field by field and ignores keys it does not know", () => {
    const rules = effectiveDataQualityRules({
      account_no_phone: { enabled: false },
      duplicate_customers: { severity: "critical", raiseExceptions: true },
      retired_rule: { enabled: true },
    });
    const by = Object.fromEntries(rules.map((r) => [r.key, r]));
    expect(by.account_no_phone).toMatchObject({ enabled: false, severity: "warning", raiseExceptions: false });
    expect(by.duplicate_customers).toMatchObject({ enabled: true, severity: "critical", raiseExceptions: true });
    expect(by.account_no_coordinates).toMatchObject({ enabled: true, raiseExceptions: false });
    expect(rules.map((r) => r.key)).not.toContain("retired_rule");
  });
});

describe("cleanPercent", () => {
  it("is the share of clean accounts to one decimal", () => {
    expect(cleanPercent(0, 0)).toBe(100);
    expect(cleanPercent(10, 0)).toBe(100);
    expect(cleanPercent(10, 10)).toBe(0);
    expect(cleanPercent(3, 1)).toBe(66.7);
    expect(cleanPercent(8, 1)).toBe(87.5);
  });
});
