import { APPLICATION_STAGES, type ApplicationStage } from "@flowless/shared-types";
import { describe, expect, it } from "vitest";
import {
  ADVANCE_ACTIONS,
  activeStages,
  applicationConfigSchema,
  canRecordSurvey,
  isFinalStage,
  nextStage,
  planAdvance,
  planEnd,
  type AdvanceAction,
  type ApplicationConfig,
} from "./application-stages";

const config = (patch: Record<string, unknown> = {}): ApplicationConfig => applicationConfigSchema.parse(patch);
const off = { required: false };
const actions = Object.keys(ADVANCE_ACTIONS) as AdvanceAction[];

describe("application stages (C-05)", () => {
  it("uses every milestone by default, in order", () => {
    expect(activeStages(config())).toEqual(["enquiry", "survey", "application", "invoice", "payment", "installation", "ready", "converted"]);
  });

  it("drops only the waived milestones", () => {
    expect(activeStages(config({ survey: off }))).not.toContain("survey");
    expect(activeStages(config({ invoice: off }))).toEqual(["enquiry", "survey", "application", "installation", "ready", "converted"]);
    expect(activeStages(config({ installation: off, invoice: off, survey: off }))).toEqual(["enquiry", "application", "ready", "converted"]);
  });

  it("walks the whole path one action at a time", () => {
    const c = config();
    let stage: ApplicationStage = "enquiry";
    for (const action of ["recordSurvey", "submitApplication", "markInvoiced", "markPaid", "startInstallation", "markReady", "convert"] as const) {
      const step = planAdvance(stage, action, c);
      expect(step).toEqual({ ok: true, to: ADVANCE_ACTIONS[action] });
      if (step.ok) stage = step.to;
    }
    expect(stage).toBe("converted");
  });

  it("allows an action only from the stage right before its target (no skipping)", () => {
    for (const waived of [{}, { survey: off }, { invoice: off }, { installation: off }, { survey: off, invoice: off, installation: off }]) {
      const c = config(waived);
      const path = activeStages(c);
      for (const from of APPLICATION_STAGES) {
        for (const action of actions) {
          const step = planAdvance(from, action, c);
          const target = ADVANCE_ACTIONS[action];
          const expected = !isFinalStage(from) && path.includes(target) && path.indexOf(from) >= 0 && path[path.indexOf(from) + 1] === target;
          expect(step.ok, `${JSON.stringify(waived)} ${from} ${action}`).toBe(expected);
        }
      }
    }
  });

  it("skips a waived stage by name: the next action goes from the stage before it", () => {
    const c = config({ survey: off, invoice: off, installation: off });
    expect(planAdvance("enquiry", "submitApplication", c)).toEqual({ ok: true, to: "application" });
    expect(planAdvance("application", "markReady", c)).toEqual({ ok: true, to: "ready" });
    expect(planAdvance("enquiry", "recordSurvey", c)).toEqual({ ok: false, problem: "This organization does not require a survey" });
    expect(planAdvance("application", "markInvoiced", c)).toMatchObject({ ok: false, problem: expect.stringContaining("does not require") });
    expect(planAdvance("application", "startInstallation", c)).toMatchObject({ ok: false });
  });

  it("refuses to skip a required stage", () => {
    const c = config();
    expect(planAdvance("enquiry", "submitApplication", c)).toMatchObject({ ok: false, problem: expect.stringContaining("not possible at the enquiry stage") });
    expect(planAdvance("application", "markPaid", c)).toMatchObject({ ok: false });
    expect(planAdvance("payment", "convert", c)).toMatchObject({ ok: false });
    expect(planAdvance("survey", "survey" as AdvanceAction, c)).toMatchObject({ ok: false });
  });

  it("never leaves a final stage", () => {
    for (const final of ["converted", "rejected", "cancelled"] as const) {
      expect(isFinalStage(final)).toBe(true);
      expect(nextStage(final, config())).toBeNull();
      for (const action of actions) expect(planAdvance(final, action, config()).ok).toBe(false);
      expect(planEnd(final, "rejected").ok).toBe(false);
      expect(planEnd(final, "cancelled").ok).toBe(false);
    }
  });

  it("rejects or cancels from any open stage", () => {
    for (const stage of activeStages(config()).filter((s) => s !== "converted")) {
      expect(planEnd(stage, "rejected")).toEqual({ ok: true, to: "rejected" });
      expect(planEnd(stage, "cancelled")).toEqual({ ok: true, to: "cancelled" });
    }
  });

  it("records a survey only at the enquiry, and not while an approval is pending", () => {
    const c = config();
    expect(canRecordSurvey("enquiry", null, c).ok).toBe(true);
    expect(canRecordSurvey("enquiry", "rejected", c).ok).toBe(true);
    expect(canRecordSurvey("enquiry", "pending", c)).toEqual({ ok: false, problem: "The survey is waiting for approval" });
    expect(canRecordSurvey("survey", null, c).ok).toBe(false);
    expect(canRecordSurvey("enquiry", null, config({ survey: off })).ok).toBe(false);
  });

  it("reads an empty setting as the defaults and keeps old stored values readable", () => {
    expect(config()).toEqual({
      survey: { required: true },
      invoice: { required: true },
      installation: { required: true },
      relocation: { surveyRequired: true },
    });
    expect(config({ survey: {} }).survey.required).toBe(true);
  });
});
