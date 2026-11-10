import { DEFAULT_ROLES } from "@flowless/shared-types";
import { describe, expect, it } from "vitest";
import { abilitiesOf, abilityLines, roleLabel } from "./permissions";

describe("abilities from the default roles", () => {
  it("a technician acts on their own jobs and edits the network, but approves and posts nothing", () => {
    expect(abilitiesOf(DEFAULT_ROLES.technician, "full")).toMatchObject({ edit: true, act: true, manage: false, review: false, post: false, seeJobs: true });
  });

  it("a supervisor assigns and reviews but has no execute or network edit by default", () => {
    expect(abilitiesOf(DEFAULT_ROLES.supervisor, "full")).toMatchObject({ edit: false, act: true, manage: true, review: true, post: false });
  });

  it("a GIS engineer posts", () => {
    expect(abilitiesOf(DEFAULT_ROLES.gis_engineer, "basic")).toMatchObject({ edit: true, post: true, remove: true, seeJobs: true });
  });

  it("sees no jobs when neither Work Orders nor GIS is licensed, or the member has no work permission", () => {
    expect(abilitiesOf(DEFAULT_ROLES.technician, "none").seeJobs).toBe(false);
    expect(abilitiesOf(DEFAULT_ROLES.cashier, "full").seeJobs).toBe(false);
  });
});

describe("metering abilities", () => {
  it("need the licence and the permissions", () => {
    expect(abilitiesOf(DEFAULT_ROLES.technician, "full", ["metering"])).toMatchObject({ readings: true, changeMeter: false });
    expect(abilitiesOf(DEFAULT_ROLES.technician, "full", []).readings).toBe(false);
    expect(abilitiesOf(DEFAULT_ROLES.supervisor, "full", ["metering"])).toMatchObject({ readings: false, changeMeter: true });
    expect(abilitiesOf(DEFAULT_ROLES.cashier, "full", ["metering"])).toMatchObject({ readings: false, changeMeter: false });
  });
});

describe("labels", () => {
  it("names roles", () => {
    expect(roleLabel("gis_engineer")).toBe("GIS engineer");
    expect(roleLabel("owner")).toBe("Owner");
  });

  it("lists what a read-only member can do", () => {
    expect(abilityLines(abilitiesOf(["gis:read"], "basic"))).toEqual(["View the network and its history"]);
  });
});
