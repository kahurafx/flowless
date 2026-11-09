import { DATA_QUALITY_RULES } from "@flowless/shared-types";
import { describe, expect, it } from "vitest";
import { cleanHeadline, defaultRule, duplicateKeyText, ruleSourceLabel, ruleTiles, type SummaryRule } from "./data-quality-view";

const rule = (over: Partial<SummaryRule> & Pick<SummaryRule, "key">): SummaryRule => ({ label: over.key, severity: "warning", state: "enabled", count: 0, ...over });

describe("data-quality tiles (C-12)", () => {
  it("tones a count by its severity and stays calm at zero", () => {
    const tiles = ruleTiles([
      rule({ key: "account_no_phone", count: 3, severity: "warning" }),
      rule({ key: "account_category_missing", count: 1, severity: "critical" }),
      rule({ key: "account_no_coordinates", count: 12, severity: "info" }),
      rule({ key: "account_no_service_point", count: 0 }),
    ]);
    expect(tiles.map((t) => t.tone)).toEqual(["warning", "destructive", "info", "success"]);
    expect(tiles.map((t) => t.caption)).toEqual(["3 accounts flagged", "1 account flagged", "12 accounts flagged", "Nothing flagged"]);
    expect(tiles.map((t) => t.browsable)).toEqual([true, true, true, false]);
  });
  it("says a rule with no source is waiting on Metering, and a switched-off rule is disabled", () => {
    const [waiting, off] = ruleTiles(
      [rule({ key: "active_metered_no_meter", state: "no_source", count: null, severity: "critical" }), rule({ key: "zone_equals_route", state: "disabled", count: null })],
      (key) => ruleSourceLabel(DATA_QUALITY_RULES.find((r) => r.key === key)!.source),
    );
    expect(waiting).toMatchObject({ figure: { kind: "waiting" }, caption: "Waiting on Metering", tone: "secondary", browsable: false });
    expect(off).toMatchObject({ figure: { kind: "disabled" }, caption: "Switched off in settings", browsable: false });
  });
});

describe("clean headline", () => {
  it("reads in words and tones by how clean", () => {
    expect(cleanHeadline({ examined: 0, flagged: 0, cleanPercent: 100 }).sentence).toBe("No accounts to examine yet.");
    expect(cleanHeadline({ examined: 50, flagged: 0, cleanPercent: 100 })).toMatchObject({ tone: "success", sentence: "All 50 accounts are clean." });
    expect(cleanHeadline({ examined: 1000, flagged: 1, cleanPercent: 99.9 })).toMatchObject({ tone: "info", sentence: "1 of 1,000 accounts has at least one finding." });
    expect(cleanHeadline({ examined: 10, flagged: 2, cleanPercent: 80 }).tone).toBe("warning");
    expect(cleanHeadline({ examined: 10, flagged: 6, cleanPercent: 40 }).tone).toBe("destructive");
  });
});

describe("duplicate groups", () => {
  it("shows phones with a plus and ids as they are", () => {
    expect(duplicateKeyText("phone", "254712345678")).toBe("+254712345678");
    expect(duplicateKeyText("national_id", "12345678")).toBe("12345678");
  });
});

describe("default rule", () => {
  it("lists the most serious rule that has findings first", () => {
    const tiles = ruleTiles([
      rule({ key: "account_no_phone", count: 9, severity: "warning" }),
      rule({ key: "account_no_coordinates", count: 20, severity: "info" }),
      rule({ key: "account_category_missing", count: 1, severity: "critical" }),
    ]);
    expect(defaultRule(tiles)).toBe("account_category_missing");
    expect(defaultRule(ruleTiles([rule({ key: "account_no_phone", count: 0 }), rule({ key: "zone_equals_route", state: "disabled", count: null })]))).toBeNull();
  });
});
