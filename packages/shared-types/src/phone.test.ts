import { describe, expect, it } from "vitest";
import { callingCodeOf, parsePhone } from "./phone";

// C-01: placeholder phones count as no phone; everything else is held in 254 format.
describe("parsePhone", () => {
  it.each([
    ["0712 345 678", "254712345678"],
    ["+254 712-345-678", "254712345678"],
    ["254712345678", "254712345678"],
    ["712345678", "254712345678"],
    ["00254712345678", "254712345678"],
    ["(0712) 345.678", "254712345678"],
    ["0112345678", "254112345678"],
    ["020 2345678", "254202345678"],
    ["+44 20 7946 0958", "442079460958"],
  ])("%s is valid as %s", (raw, digits) => {
    expect(parsePhone(raw)).toEqual({ kind: "valid", digits });
  });

  it.each([
    "25400000000",
    "254000000000",
    "+254000000000",
    "0000000000",
    "000000000",
    "0",
    "",
    "   ",
    "0777777777",
    "254111111111",
    "+254 999 999 999",
    "777777777",
    "11111111",
    "+999999999999",
  ])("%j is a placeholder", (raw) => {
    expect(parsePhone(raw)).toEqual({ kind: "placeholder" });
  });

  it("treats null and undefined as no phone", () => {
    expect(parsePhone(null)).toEqual({ kind: "placeholder" });
    expect(parsePhone(undefined)).toEqual({ kind: "placeholder" });
  });

  it.each(["abc", "0712 345 67", "+254 12", "0712x345678", "254 7123456789", "1234567", "07+12345678", "00254 71", "+44 1"])(
    "%j is invalid",
    (raw) => {
      expect(parsePhone(raw).kind).toBe("invalid");
    },
  );

  it("spellings of one number agree, so duplicates are found across them", () => {
    const spellings = ["0712345678", "+254712345678", "254 712 345 678", "712-345-678", "00254712345678"];
    expect(new Set(spellings.map((s) => JSON.stringify(parsePhone(s)))).size).toBe(1);
  });

  it("uses the organization's country code", () => {
    expect(parsePhone("0712345678", "255")).toEqual({ kind: "valid", digits: "255712345678" });
    expect(parsePhone("0000000000", "255")).toEqual({ kind: "placeholder" });
    expect(parsePhone("+254712345678", "255")).toEqual({ kind: "valid", digits: "254712345678" });
  });
});

describe("callingCodeOf", () => {
  it("reads the region of the locale and falls back to Kenya", () => {
    expect(callingCodeOf("en-KE")).toBe("254");
    expect(callingCodeOf("sw-TZ")).toBe("255");
    expect(callingCodeOf("en")).toBe("254");
    expect(callingCodeOf("en-XX")).toBe("254");
    expect(callingCodeOf(null)).toBe("254");
  });
});
