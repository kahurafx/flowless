import type { ApplicationStage, Permission } from "@flowless/shared-types";
import { describe, expect, it } from "vitest";
import { areaChoices, stillOffered } from "./area-options";
import { areaField,contactInputs, newCustomerInput, parseCoordinates, parseMinorUnits, placeInput } from "./account-forms";
import { commandKindLabel } from "./account-labels";
import { canOverrideGates, lifecycleActionsFor } from "./account-lifecycle";
import { nextUsedStage, offersFor, stageBeforeEnd, stageLine } from "./application-view";
import { ACCOUNT_COMMAND_KINDS } from "@flowless/shared-types";

const ALL_USED: ApplicationStage[] = ["enquiry", "survey", "application", "invoice", "payment", "installation", "ready", "converted"];
const NO_SURVEY_OR_INVOICE: ApplicationStage[] = ["enquiry", "application", "installation", "ready", "converted"];
const states = (steps: ReturnType<typeof stageLine>) => steps.map((s) => s.state);

describe("application stage line (C-05)", () => {
  it("marks done, current and upcoming steps", () => {
    expect(states(stageLine("application", ALL_USED))).toEqual(["done", "done", "current", "upcoming", "upcoming", "upcoming", "upcoming", "upcoming"]);
  });

  it("shows a waived stage as skipped, never as done or upcoming", () => {
    const line = stageLine("application", NO_SURVEY_OR_INVOICE);
    expect(line.filter((s) => s.state === "skipped").map((s) => s.stage)).toEqual(["survey", "invoice", "payment"]);
    expect(line.find((s) => s.stage === "application")?.state).toBe("current");
    expect(line.find((s) => s.stage === "installation")?.state).toBe("upcoming");
  });

  it("converted is all done; an ended application stops where it had got to", () => {
    expect(new Set(states(stageLine("converted", ALL_USED)))).toEqual(new Set(["done"]));
    const rejected = stageLine("rejected", ALL_USED, "survey");
    expect(rejected.find((s) => s.stage === "survey")?.state).toBe("stopped");
    expect(rejected.find((s) => s.stage === "enquiry")?.state).toBe("done");
    expect(rejected.find((s) => s.stage === "application")?.state).toBe("upcoming");
  });

  it("finds the stage reached before the end in the step log", () => {
    const events = [
      { kind: "created", fromStage: "enquiry", toStage: "enquiry" },
      { kind: "stage_changed", fromStage: "enquiry", toStage: "survey" },
      { kind: "stage_changed", fromStage: "survey", toStage: "cancelled" },
    ] as const;
    expect(stageBeforeEnd(events)).toBe("survey");
    expect(stageBeforeEnd(events.slice(0, 2))).toBeNull();
  });

  it("skips waived stages when finding the next one", () => {
    expect(nextUsedStage("application", NO_SURVEY_OR_INVOICE)).toBe("installation");
    expect(nextUsedStage("converted", ALL_USED)).toBeNull();
    expect(nextUsedStage("rejected", ALL_USED)).toBeNull();
  });
});

describe("what an application offers", () => {
  const office: Permission[] = ["accounts:read", "accounts:update", "accounts:create"];
  const app = (stage: ApplicationStage, extra: Partial<Parameters<typeof offersFor>[0]> = {}) => ({
    stage,
    surveyApprovalState: null,
    surveyFeasibility: null,
    ...extra,
  });

  it("offers the survey form on an enquiry, not the next step", () => {
    expect(offersFor(app("enquiry"), ALL_USED, office)).toMatchObject({ recordSurvey: true, advance: null, end: true });
  });

  it("waits while the survey is pending approval", () => {
    const offers = offersFor(app("enquiry", { surveyApprovalState: "pending", surveyFeasibility: "feasible" }), ALL_USED, office);
    expect(offers.recordSurvey).toBe(false);
    expect(offers.waiting).toMatch(/waiting for approval/);
  });

  it("goes straight to submit when the survey is waived", () => {
    expect(offersFor(app("enquiry"), NO_SURVEY_OR_INVOICE, office)).toMatchObject({ advance: "submit", recordSurvey: false });
  });

  it("maps each stage to its next action, and convert needs accounts:create", () => {
    expect(offersFor(app("survey"), ALL_USED, office).advance).toBe("submit");
    expect(offersFor(app("application"), ALL_USED, office).advance).toBe("invoiced");
    expect(offersFor(app("invoice"), ALL_USED, office).advance).toBe("paid");
    expect(offersFor(app("payment"), ALL_USED, office).advance).toBe("installation");
    expect(offersFor(app("installation"), ALL_USED, office).advance).toBe("ready");
    expect(offersFor(app("ready"), ALL_USED, office).advance).toBe("convert");
    expect(offersFor(app("ready"), ALL_USED, ["accounts:read", "accounts:update"]).advance).toBeNull();
  });

  it("offers nothing to a reader, and nothing once ended", () => {
    expect(offersFor(app("application"), ALL_USED, ["accounts:read"])).toMatchObject({ advance: null, end: false, recordSurvey: false });
    expect(offersFor(app("converted"), ALL_USED, office)).toMatchObject({ advance: null, end: false });
    expect(offersFor(app("rejected"), ALL_USED, office).end).toBe(false);
  });
});

describe("lifecycle actions offered (C-03)", () => {
  const manager: Permission[] = ["accounts:read", "accounts:change_status"];

  it("offers nothing without accounts:change_status", () => {
    expect(lifecycleActionsFor({ commercialStatus: "ACTIVE", serviceStatus: "CONNECTED" }, ["accounts:read", "accounts:update"])).toEqual([]);
  });

  it("follows the state machine on both axes", () => {
    expect(lifecycleActionsFor({ commercialStatus: "NEW", serviceStatus: "DISCONNECTED" }, manager)).toEqual(["mark_pending_payment", "activate", "terminate", "change_name"]);
    expect(lifecycleActionsFor({ commercialStatus: "ACTIVE", serviceStatus: "CONNECTED" }, manager)).toEqual([
      "make_dormant",
      "disconnect_service",
      "terminate",
      "succeed",
      "change_name",
      "relocate",
    ]);
    expect(lifecycleActionsFor({ commercialStatus: "ACTIVE", serviceStatus: "DISCONNECTED" }, manager)).toContain("reconnect_service");
    expect(lifecycleActionsFor({ commercialStatus: "DORMANT", serviceStatus: "DISCONNECTED" }, manager)).toContain("reactivate");
    expect(lifecycleActionsFor({ commercialStatus: "TERMINATED", serviceStatus: "DISCONNECTED" }, manager)).toEqual([]);
  });

  it("override needs settings:manage", () => {
    expect(canOverrideGates(["settings:manage"])).toBe(true);
    expect(canOverrideGates(manager)).toBe(false);
  });

  it("names every logged command", () => {
    for (const kind of ACCOUNT_COMMAND_KINDS) expect(commandKindLabel[kind]).toBeTruthy();
  });
});

describe("account forms", () => {
  it("reads coordinates as a pair or nothing", () => {
    expect(parseCoordinates("", "")).toEqual({ ok: true, value: null });
    expect(parseCoordinates("-1.2", "36.9")).toEqual({ ok: true, value: { lat: -1.2, lng: 36.9 } });
    expect(parseCoordinates("-1.2", "").ok).toBe(false);
    expect(parseCoordinates("abc", "36").ok).toBe(false);
    expect(parseCoordinates("91", "36").ok).toBe(false);
    expect(parseCoordinates("0", "181").ok).toBe(false);
  });

  it("puts the identity number where the customer type keeps it", () => {
    const base = { name: " Grace ", language: "", notes: "", contacts: [] };
    expect(newCustomerInput({ ...base, type: "person", identity: " 12345678 " })).toEqual({ type: "person", name: "Grace", nationalId: "12345678", contacts: [] });
    expect(newCustomerInput({ ...base, type: "organization", identity: "CPR/1" })).toMatchObject({ registrationNumber: "CPR/1" });
    expect(newCustomerInput({ ...base, type: "person", identity: "" })).not.toHaveProperty("nationalId");
  });

  it("drops blank contacts", () => {
    const rows = [
      { channel: "phone", value: " 0712345678 ", kind: "personal", isPrimary: true },
      { channel: "email", value: "  ", kind: "personal", isPrimary: false },
    ] as const;
    expect(contactInputs(rows)).toHaveLength(1);
    expect(contactInputs(rows)[0]?.value).toBe("0712345678");
  });

  it("builds a place without empty ids", () => {
    expect(placeInput({ address: " Plot 4 ", zoneId: "z", routeId: "" }, { lat: 1, lng: 2 })).toEqual({ address: "Plot 4", zoneId: "z", location: { lat: 1, lng: 2 } });
    expect(placeInput({ address: "x" }, null)).toEqual({ address: "x" });
  });

  it("files areas under the API's three fields", () => {
    expect(areaField("scheme")).toBe("schemeId");
    expect(areaField("sub_zone")).toBe("zoneId");
    expect(areaField("dma")).toBe("dmaId");
  });

  it("parses amounts into minor units without floats", () => {
    expect(parseMinorUnits("1250.5")).toBe(125050n);
    expect(parseMinorUnits("10")).toBe(1000n);
    expect(parseMinorUnits("0")).toBeNull();
    expect(parseMinorUnits("1.234")).toBeNull();
    expect(parseMinorUnits("-5")).toBeNull();
    expect(parseMinorUnits("abc")).toBeNull();
  });
});

describe("place pickers", () => {
  const areas = [
    { id: "s1", name: "North scheme", level: "scheme", parentId: null },
    { id: "s2", name: "South scheme", level: "scheme", parentId: null },
    { id: "z1", name: "Kahawa", level: "zone", parentId: "s1" },
    { id: "z2", name: "Ruiru", level: "zone", parentId: "s2" },
    { id: "sz1", name: "Kahawa West", level: "sub_zone", parentId: "z1" },
    { id: "d1", name: "DMA 1", level: "dma", parentId: "sz1" },
  ] as const;

  it("offers only the zones under the chosen scheme", () => {
    expect(areaChoices(areas, ["zone", "sub_zone"], ["s1"]).map((c) => c.value)).toEqual(["z1", "sz1"]);
    expect(areaChoices(areas, ["zone", "sub_zone"], ["s2"]).map((c) => c.value)).toEqual(["z2"]);
    expect(areaChoices(areas, ["zone", "sub_zone"], [""]).map((c) => c.value)).toEqual(["z1", "sz1", "z2"]);
  });

  it("offers DMAs under every chosen ancestor, however many levels apart", () => {
    expect(areaChoices(areas, ["dma"], ["s1", "z1"]).map((c) => c.value)).toEqual(["d1"]);
    expect(areaChoices(areas, ["dma"], ["s2"])).toEqual([]);
  });

  it("notices a selection that is no longer offered", () => {
    expect(stillOffered([{ value: "z1" }], "z2")).toBe(false);
    expect(stillOffered([{ value: "z1" }], "")).toBe(true);
  });
});
