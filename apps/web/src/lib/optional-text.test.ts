import { describe, expect, it } from "vitest";
import { optionalText } from "./optional-text";

describe("optionalText", () => {
  it("keeps trimmed text under its key", () => {
    expect(optionalText("note", "  gate locked ")).toEqual({ note: "gate locked" });
  });

  it("is nothing for empty, blank, null or undefined text", () => {
    expect(optionalText("note", "")).toEqual({});
    expect(optionalText("note", " \n\t ")).toEqual({});
    expect(optionalText("note", null)).toEqual({});
    expect(optionalText("note", undefined)).toEqual({});
  });

  it("spreads into an input without leaving the key behind", () => {
    const input = { id: "1", ...optionalText("note", "  ") };
    expect(Object.keys(input)).toEqual(["id"]);
  });
});
