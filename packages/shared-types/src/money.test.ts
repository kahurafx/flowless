import { describe, expect, it } from "vitest";
import { formatMoney, money, sumMoney, toDecimalString } from "./money";

// B-18: integer minor units, exact conversion, no floats.
describe("money", () => {
  it("converts minor units to an exact decimal string", () => {
    expect(toDecimalString(money(64500n, "KES"))).toBe("645.00");
    expect(toDecimalString(money(-1500n, "KES"))).toBe("-15.00");
    expect(toDecimalString(money(5n, "KES"))).toBe("0.05");
    expect(toDecimalString(money(500n, "JPY"))).toBe("500");
  });

  it("keeps precision beyond Number.MAX_SAFE_INTEGER", () => {
    expect(toDecimalString(money(9007199254740993n, "KES"))).toBe("90071992547409.93");
  });

  it("sums one currency and rejects mixing", () => {
    expect(sumMoney("KES", [money(48000n, "KES"), money(-49500n, "KES")]).amountMinor).toBe(-1500n);
    expect(() => sumMoney("KES", [money(1n, "USD")])).toThrow(/USD/);
  });

  it("formats for the organization's locale", () => {
    expect(formatMoney(money(183900n, "KES"), "en-KE")).toMatch(/1,839\.00/);
  });
});
