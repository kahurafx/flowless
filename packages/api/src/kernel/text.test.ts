import { describe, expect, it } from "vitest";
import { notFound } from "./errors";
import { plain, tidy } from "./text";

describe("tidy", () => {
  it("trims and collapses inner whitespace of any kind", () => {
    expect(tidy("  Kahawa   West \t Road\n")).toBe("Kahawa West Road");
  });
  it("leaves a tidy text alone and turns blank into an empty string", () => {
    expect(tidy("Plot 12")).toBe("Plot 12");
    expect(tidy(" \n\t ")).toBe("");
  });
});

describe("plain", () => {
  it("turns bigint money into decimal strings, at any depth", () => {
    expect(plain({ amount: 1_234_567_890_123_456_789n, lines: [{ rate: 5n }] })).toEqual({
      amount: "1234567890123456789",
      lines: [{ rate: "5" }],
    });
  });
  it("turns dates into ISO strings and drops undefined", () => {
    expect(plain({ at: new Date("2026-01-02T03:04:05.000Z"), gone: undefined, none: null })).toEqual({
      at: "2026-01-02T03:04:05.000Z",
      none: null,
    });
  });
  it("passes null through", () => {
    expect(plain(null)).toBeNull();
  });
});

describe("notFound", () => {
  it("is a NOT_FOUND tRPC error naming what was missing", () => {
    const error = notFound("Account");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("Account not found");
  });
});
