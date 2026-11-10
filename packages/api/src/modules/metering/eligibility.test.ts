import { describe, expect, it } from "vitest";
import { eligibilityOf } from "./eligibility";

describe("eligibilityOf (M-08)", () => {
  const fact = (connectionStatus: string, billsConsumption: boolean) => ({ connectionStatus, billsConsumption });
  it("decides in a fixed order: live, billed, metered", () => {
    expect(eligibilityOf(fact("CONNECTED", true), true)).toEqual({ eligible: true, reason: "eligible" });
    expect(eligibilityOf(fact("CONNECTED", true), false)).toEqual({ eligible: false, reason: "no_meter" });
    expect(eligibilityOf(fact("CONNECTED", false), true)).toEqual({ eligible: false, reason: "consumption_not_billed" });
    expect(eligibilityOf(fact("DISCONNECTED", true), true)).toEqual({ eligible: true, reason: "eligible" });
    expect(eligibilityOf(fact("DECOMMISSIONED", false), false)).toEqual({ eligible: false, reason: "service_point_not_live" });
    expect(eligibilityOf(fact("PLANNED", true), true)).toEqual({ eligible: false, reason: "service_point_not_live" });
  });
});
