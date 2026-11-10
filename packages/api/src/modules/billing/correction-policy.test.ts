import { describe, expect, it } from "vitest";
import { correctionPath, type PathInput, correctionSettingsSchema, formatMinor, graceEnd, isLargeDeviation, renderTemplate } from "./correction-policy";

const s = correctionSettingsSchema.parse({});

describe("grace window (B-14)", () => {
  it("defaults to the invoice due date and falls back to issue date plus days", () => {
    expect(graceEnd({ issuedOn: "2025-03-01", dueOn: "2025-03-15" }, s.graceWindow)).toBe("2025-03-15");
    expect(graceEnd({ issuedOn: "2025-03-01", dueOn: null }, s.graceWindow)).toBe("2025-03-31");
    expect(graceEnd({ issuedOn: "2025-03-01", dueOn: "2025-03-15" }, { basis: "days_after_issue", days: 10 })).toBe("2025-03-11");
    expect(graceEnd(null, s.graceWindow)).toBeNull();
  });
});

describe("correction path", () => {
  const base: PathInput = { today: "2025-03-10", graceEnd: "2025-03-15", total: 1000n, originalTotal: 10_000n as bigint | null, largeDeviation: s.largeDeviation, evidence: false };
  const cases: [string, Partial<PathInput>, { route: string; needsEvidence: boolean; large: boolean }][] = [
    ["inside the window, small", {}, { route: "clerk", needsEvidence: false, large: false }],
    ["last day of the window", { today: "2025-03-15" }, { route: "clerk", needsEvidence: false, large: false }],
    ["after the window", { today: "2025-03-16" }, { route: "approval", needsEvidence: false, large: false }],
    ["no original invoice", { graceEnd: null, originalTotal: null, total: 0n }, { route: "approval", needsEvidence: false, large: false }],
    ["large inside the window without evidence", { total: -6000n }, { route: "clerk", needsEvidence: true, large: true }],
    ["large inside the window with evidence", { total: -6000n, evidence: true }, { route: "clerk", needsEvidence: false, large: true }],
    ["large after the window without evidence", { today: "2025-04-01", total: 9000n }, { route: "approval", needsEvidence: true, large: true }],
    ["exactly at the percent limit is not large", { total: 5000n }, { route: "clerk", needsEvidence: false, large: false }],
  ];
  for (const [name, over, want] of cases) {
    it(name, () => expect(correctionPath({ ...base, ...over })).toMatchObject(want));
  }

  it("treats a large absolute amount as large when the amount limit is set", () => {
    const limit = { percent: 0, amount: "50000" };
    expect(isLargeDeviation(49_999n, 1_000_000n, limit)).toBe(false);
    expect(isLargeDeviation(-50_000n, 1_000_000n, limit)).toBe(true);
    expect(isLargeDeviation(100n, 0n, { percent: 50, amount: "0" })).toBe(true);
    expect(isLargeDeviation(0n, 0n, { percent: 50, amount: "0" })).toBe(false);
    expect(isLargeDeviation(10n ** 9n, 5n, { percent: 0, amount: "0" })).toBe(false);
  });
});

describe("plain-language text (B-13)", () => {
  it("fills the template and leaves unknown names alone", () => {
    expect(renderTemplate(s.creditTemplate, { original_number: "INV-000001", period: "2025-02", amount: "KES 12.00", from: "2025-02-01", to: "2025-02-28" })).toBe(
      "Correction to your bill INV-000001 for 2025-02: after a reading was corrected, KES 12.00 is credited for 2025-02-01 to 2025-02-28.",
    );
    expect(renderTemplate("a {x} {y}", { x: "1" })).toBe("a 1 {y}");
  });
  it("formats money from integer minor units", () => {
    expect(formatMinor(-123_456n, "KES")).toBe("KES 1,234.56");
    expect(formatMinor(5n, "KES")).toBe("KES 0.05");
  });
});
