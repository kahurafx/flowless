import { describe, expect, it } from "vitest";
import { reasonPayload } from "./reason-payload";

describe("reasonPayload (C-03)", () => {
  it("trims the reason and the note", () => {
    expect(reasonPayload("a", "  moved away ", " left a key ")).toEqual({ id: "a", reason: "moved away", note: "left a key" });
  });

  it("leaves the note out when it is blank", () => {
    expect(reasonPayload("a", "moved away", "  ")).toEqual({ id: "a", reason: "moved away" });
  });
});
