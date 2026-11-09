import { describe, expect, it } from "vitest";
import { kernelRegistrar } from "./kernel/registrar";
import { approvals, consumers, fileSubjects, reports, settings } from "./wiring";

// The kernel imports no module: everything below arrives through `wiring.ts`.
describe("wiring", () => {
  it("registers every module's consumers, in module order, after the kernel's", () => {
    expect(consumers.map((c) => c.name)).toEqual([
      "kernel.organization_settings",
      "gis.seed_attachment_rules",
      "tariffs.seed_defaults_on_creation",
      "tariffs.seed_defaults_on_licence",
      "accounts.record_write_off_decision",
      "accounts.apply_survey_decision",
      "accounts.record_survey_from_job",
      "accounts.record_relocation_from_job",
    ]);
  });

  it("registers file subjects, reports and approval kinds", () => {
    expect(fileSubjects.map((s) => s.kind)).toHaveLength(2);
    expect(fileSubjects.map((s) => s.kind)).toContain("work_order");
    expect(reports.map((r) => r.key)).toEqual([
      "gis.recent_findings",
      "gis.condition_trend",
      "accounts.data_quality_summary",
      "accounts.data_quality_findings",
    ]);
    expect(approvals.map((a) => a.key)).toEqual(["accounts.write_off", "accounts.connection_survey"]);
  });

  it("lists the kernel and module settings first, then each approval's policy", () => {
    const keys = settings.map((s) => s.key);
    expect(keys[0]).toBe("kernel.regional");
    expect(keys).toContain("tariffs.policy");
    const policies = approvals.map((a) => `approvals.${a.key}`);
    expect(keys.slice(-policies.length)).toEqual(policies);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("refuses a name, key or type registered twice", () => {
    expect(() => kernelRegistrar.consumer(consumers[0]!)).toThrow(/registered twice/);
    expect(() => kernelRegistrar.fileSubject(fileSubjects[0]!)).toThrow(/registered twice/);
    expect(() => kernelRegistrar.report(reports[0]!)).toThrow(/registered twice/);
    expect(() => kernelRegistrar.approval(approvals[0]!)).toThrow(/registered twice/);
    expect(() => kernelRegistrar.setting(settings[0]!)).toThrow(/registered twice/);
  });
});
