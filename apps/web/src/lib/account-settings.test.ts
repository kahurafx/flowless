import { CHARGE_TYPES, DATA_QUALITY_RULES, type ChargeType } from "@flowless/shared-types";
import { describe, expect, it } from "vitest";
// The API's pure schemas, imported by path only to check that what the forms write is what the store accepts.
import { activationConfigSchema } from "../../../../packages/api/src/modules/accounts/gates";
import { applicationConfigSchema } from "../../../../packages/api/src/modules/accounts/application-stages";
import { dataQualityConfigSchema } from "../../../../packages/api/src/modules/accounts/data-quality-config";
import { membershipConfigSchema } from "../../../../packages/api/src/modules/accounts/membership";
import { numberingFormatSchema } from "../../../../packages/api/src/modules/accounts/numbering";
import { statusRulesSchema } from "../../../../packages/api/src/modules/accounts/status-rules";
import { approvalPolicySchema } from "../../../../packages/api/src/kernel/approval-store";
import {
  SETTING_KEYS,
  activationFromForm,
  activationToForm,
  applicationFromForm,
  applicationToForm,
  approvalPolicyFromForm,
  approvalPolicyToForm,
  dataQualityFromForm,
  dataQualityToForm,
  effectiveFromOf,
  keyFromLabel,
  membershipFromForm,
  membershipToForm,
  numberingFromForm,
  numberingToForm,
  startOfDayIn,
  statusRulesFromForm,
  statusRulesToForm,
  summarize,
  toggleChargeType,
  toggleConsumption,
  type ActivationValue,
  type ApprovalPolicyValue,
  type NumberingValue,
  type StatusRulesValue,
} from "./account-settings";

const KES = "KES";
const defaults = {
  numbering: numberingFormatSchema.parse({}) as NumberingValue,
  statusRules: statusRulesSchema.parse({}) as StatusRulesValue,
  activation: activationConfigSchema.parse(undefined) as ActivationValue,
  application: applicationConfigSchema.parse({}),
  membership: membershipConfigSchema.parse({}),
  dataQuality: dataQualityConfigSchema.parse({}),
};

describe("accounts.numbering form (C-02)", () => {
  it("round-trips the default and what the store accepts", () => {
    const form = numberingToForm(defaults.numbering);
    expect(form).toEqual({ prefix: "", width: "4", start: "1001", checkDigit: "luhn", separator: "" });
    const back = numberingFromForm(form, defaults.numbering);
    expect(back).toEqual({ ok: true, value: defaults.numbering });
  });
  it("upper-cases the prefix and keeps the child-suffix style it does not edit", () => {
    const back = numberingFromForm({ prefix: "mj", width: "6", start: "2000", checkDigit: "mod11", separator: "-" }, defaults.numbering);
    expect(back).toEqual({ ok: true, value: { prefix: "MJ", width: 6, start: 2000, checkDigit: "mod11", separator: "-", childSuffix: "letters" } });
    if (back.ok) expect(numberingFormatSchema.safeParse(back.value).success).toBe(true);
  });
  it("lists what is wrong", () => {
    const back = numberingFromForm({ prefix: "toolongprefix!", width: "0", start: "x", checkDigit: "none", separator: "" }, defaults.numbering);
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.problems).toHaveLength(3);
  });
});

describe("accounts.status_rules form (C-04)", () => {
  it("round-trips the default table", () => {
    expect(statusRulesFromForm(statusRulesToForm(defaults.statusRules))).toEqual(defaults.statusRules);
  });
  it("ties usage to billing consumption, so the store accepts every table the form can make", () => {
    let form = statusRulesToForm(defaults.statusRules);
    form = toggleConsumption(form, "DORMANT", "CONNECTED", true);
    form = toggleChargeType(form, "DORMANT", "CONNECTED", "recurring", true);
    form = toggleChargeType(form, "ACTIVE", "CONNECTED", "penalty", false);
    form = toggleConsumption(form, "ACTIVE", "DISCONNECTED", false);
    const value = statusRulesFromForm(form);
    expect(value.DORMANT.CONNECTED).toEqual({ billsConsumption: true, chargeTypes: ["usage", "recurring"] });
    expect(value.ACTIVE.CONNECTED.chargeTypes).not.toContain("penalty");
    expect(value.ACTIVE.CONNECTED.chargeTypes).toContain("usage");
    expect(statusRulesSchema.safeParse(value).success).toBe(true);
  });
  it("keeps charge types in the catalogue's order", () => {
    let form = statusRulesToForm(defaults.statusRules);
    for (const type of ["adjustment", "fee", "deposit"] as ChargeType[]) form = toggleChargeType(form, "NEW", "CONNECTED", type, true);
    const order = statusRulesFromForm(form).NEW.CONNECTED.chargeTypes;
    expect(order).toEqual(CHARGE_TYPES.filter((t) => order.includes(t)));
  });
});

describe("accounts.activation form (C-06)", () => {
  it("round-trips the default, with the threshold amount as money", () => {
    const form = activationToForm(defaults.activation, KES);
    expect(form.gates.payment_threshold).toMatchObject({ percent: "100", fixedAmount: "0.00" });
    expect(activationFromForm(form, KES)).toEqual({ ok: true, value: defaults.activation });
  });
  it("stores a fixed threshold as digits of minor units and makes keys for new checklist items", () => {
    const form = activationToForm(defaults.activation, KES);
    form.gates.payment_threshold = { ...form.gates.payment_threshold, basis: "fixed", fixedAmount: "1,500.50" };
    form.officeChecklist = [{ key: "", label: "Site visit signed off", enabled: true, required: true }];
    const back = activationFromForm(form, KES);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.value.gates.payment_threshold).toMatchObject({ basis: "fixed", fixedAmount: "150050" });
      expect(back.value.officeChecklist).toEqual([{ key: "site_visit_signed_off", label: "Site visit signed off", enabled: true, required: true }]);
      expect(activationConfigSchema.safeParse(back.value).success).toBe(true);
    }
  });
  it("refuses a duplicate key, a built-in gate's key and bad numbers", () => {
    const form = activationToForm(defaults.activation, KES);
    form.officeChecklist = [
      { key: "", label: "Meter installed", enabled: true, required: true },
      { key: "", label: "Meter  installed!", enabled: true, required: true },
    ];
    const back = activationFromForm({ ...form, staleAfterDays: "0" }, KES);
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.problems.length).toBeGreaterThanOrEqual(2);
    expect(activationFromForm({ ...form, officeChecklist: [{ key: "", label: "Initial reading", enabled: true, required: true }] }, KES).ok).toBe(false);
  });
});

describe("accounts.application form (C-05, C-09)", () => {
  it("shows used stages and writes waived ones back", () => {
    const form = applicationToForm(defaults.application);
    expect(form).toEqual({ survey: true, invoice: true, installation: true, relocationSurvey: true });
    const waived = applicationFromForm({ ...form, survey: false, relocationSurvey: false });
    expect(waived).toEqual({ survey: { required: false }, invoice: { required: true }, installation: { required: true }, relocation: { surveyRequired: false } });
    expect(applicationConfigSchema.safeParse(waived).success).toBe(true);
  });
});

describe("accounts.membership form (C-07)", () => {
  it("makes keys from labels and keeps existing ones", () => {
    const back = membershipFromForm({
      classes: [
        { key: "", label: "Full member", chargeItemCode: "member_connection" },
        { key: "associate", label: "Associate (renamed)", chargeItemCode: "" },
      ],
    });
    expect(back).toEqual({ ok: true, value: { classes: [{ key: "full_member", label: "Full member", connectionFeeChargeItemCode: "member_connection" }, { key: "associate", label: "Associate (renamed)" }] } });
    if (back.ok) expect(membershipConfigSchema.safeParse(back.value).success).toBe(true);
  });
  it("refuses two classes with the same key and a blank label", () => {
    expect(membershipFromForm({ classes: [{ key: "", label: "Member", chargeItemCode: "" }, { key: "", label: "member", chargeItemCode: "" }] }).ok).toBe(false);
    expect(membershipFromForm({ classes: [{ key: "", label: " ", chargeItemCode: "" }] }).ok).toBe(false);
  });
  it("round-trips", () => {
    const value = { classes: [{ key: "full_member", label: "Full member", connectionFeeChargeItemCode: "x" }] };
    expect(membershipFromForm(membershipToForm(value))).toEqual({ ok: true, value });
  });
});

describe("accounts.data_quality form (C-12)", () => {
  it("starts from the catalogue defaults", () => {
    const form = dataQualityToForm(defaults.dataQuality);
    for (const rule of DATA_QUALITY_RULES) expect(form[rule.key]).toEqual({ enabled: rule.defaultEnabled, severity: rule.defaultSeverity, raiseExceptions: false });
  });
  it("writes every rule and keeps a retired rule's old entry", () => {
    const form = dataQualityToForm({ rules: { retired_rule: { enabled: false } } });
    form.account_no_phone = { enabled: true, severity: "critical", raiseExceptions: true };
    form.account_no_coordinates.enabled = false;
    const value = dataQualityFromForm(form, { rules: { retired_rule: { enabled: false } } });
    expect(value.rules.account_no_phone).toEqual({ enabled: true, severity: "critical", raiseExceptions: true });
    expect(value.rules.account_no_coordinates?.enabled).toBe(false);
    expect(value.rules.retired_rule).toEqual({ enabled: false });
    expect(Object.keys(value.rules)).toHaveLength(DATA_QUALITY_RULES.length + 1);
    expect(dataQualityConfigSchema.safeParse(value).success).toBe(true);
    expect(dataQualityToForm(value).account_no_phone.severity).toBe("critical");
  });
});

describe("approval policy form (K-05)", () => {
  const surveyPolicy: ApprovalPolicyValue = { levels: [{ label: "Manager", permission: "accounts:change_status" }], slaHours: 72 };
  it("round-trips a policy and keeps reason codes it does not edit", () => {
    const withCodes = { ...surveyPolicy, reasonCodes: [{ code: "OTHER", label: "Other" }] };
    const form = approvalPolicyToForm(withCodes, KES);
    expect(form).toEqual({ levels: [{ label: "Manager", permission: "accounts:change_status", minAmount: "" }], slaHours: "72", escalateTo: "" });
    expect(approvalPolicyFromForm(form, withCodes, KES)).toEqual({ ok: true, value: withCodes });
  });
  it("reads a minimum amount as money and writes minor units as digits", () => {
    const form = approvalPolicyToForm(surveyPolicy, KES);
    form.levels.push({ label: "Finance", permission: "billing:approve", minAmount: "5,000" });
    form.escalateTo = "settings:manage";
    const back = approvalPolicyFromForm(form, surveyPolicy, KES);
    expect(back).toEqual({
      ok: true,
      value: { levels: [{ label: "Manager", permission: "accounts:change_status" }, { label: "Finance", permission: "billing:approve", minAmount: "500000" }], slaHours: 72, escalateTo: "settings:manage" },
    });
    if (back.ok) expect(approvalPolicySchema.safeParse(back.value).success).toBe(true);
    expect(approvalPolicyToForm(back.ok ? back.value : surveyPolicy, KES).levels[1]?.minAmount).toBe("5000.00");
  });
  it("allows no levels (approved at once) and refuses bad input", () => {
    const none = approvalPolicyFromForm({ levels: [], slaHours: "48", escalateTo: "" }, surveyPolicy, KES);
    expect(none).toEqual({ ok: true, value: { levels: [], slaHours: 48 } });
    expect(approvalPolicyFromForm({ levels: [{ label: "", permission: "nope", minAmount: "x" }], slaHours: "0", escalateTo: "nope" }, surveyPolicy, KES).ok).toBe(false);
    expect(approvalPolicyFromForm({ levels: Array.from({ length: 6 }, () => ({ label: "L", permission: "accounts:read", minAmount: "" })), slaHours: "48", escalateTo: "" }, surveyPolicy, KES).ok).toBe(false);
  });
});

describe("scheduled changes", () => {
  it("applies now when no date is given and refuses today or the past", () => {
    expect(effectiveFromOf("", "2027-01-15", "Africa/Nairobi")).toEqual({ ok: true, value: null });
    expect(effectiveFromOf("2027-01-15", "2027-01-15", "Africa/Nairobi").ok).toBe(false);
    expect(effectiveFromOf("2027-01-01", "2027-01-15", "Africa/Nairobi").ok).toBe(false);
    expect(effectiveFromOf("15/02/2027", "2027-01-15", "Africa/Nairobi").ok).toBe(false);
  });
  it("starts a future date at midnight in the organization's time zone", () => {
    expect(startOfDayIn("2027-02-01", "Africa/Nairobi").toISOString()).toBe("2027-01-31T21:00:00.000Z");
    expect(startOfDayIn("2027-02-01", "UTC").toISOString()).toBe("2027-02-01T00:00:00.000Z");
    expect(startOfDayIn("2027-07-01", "America/New_York").toISOString()).toBe("2027-07-01T04:00:00.000Z");
    expect(startOfDayIn("2027-12-01", "America/New_York").toISOString()).toBe("2027-12-01T05:00:00.000Z");
  });
});

describe("keys and summaries", () => {
  it("makes snake_case keys from labels", () => {
    expect(keyFromLabel("Site visit signed off", 40)).toBe("site_visit_signed_off");
    expect(keyFromLabel("  Café  ", 40)).toBe("cafe");
    expect(keyFromLabel("123 go", 40)).toBe("x_123_go");
    expect(keyFromLabel("!!!", 40)).toBe("");
  });
  it("summarizes each setting in a line", () => {
    expect(summarize(SETTING_KEYS.numbering, { ...defaults.numbering, prefix: "MJ" })).toBe("MJ, 4 digits from 1001, luhn");
    expect(summarize(SETTING_KEYS.application, applicationFromForm({ survey: false, invoice: true, installation: true, relocationSurvey: true }))).toBe("Waived: survey");
    expect(summarize(SETTING_KEYS.surveyApproval, { levels: [], slaHours: 72 })).toBe("No approval needed");
    expect(summarize(SETTING_KEYS.dataQuality, { rules: {} })).toBe("7 rules on, 0 raising exceptions");
    expect(summarize(SETTING_KEYS.membership, { classes: [] })).toBe("0 classes");
    expect(summarize(SETTING_KEYS.activation, defaults.activation)).toBe("Office checklist, stale after 14 days, 0 office items");
    expect(summarize(SETTING_KEYS.statusRules, defaults.statusRules)).toBe("Consumption billed while active");
  });
});
