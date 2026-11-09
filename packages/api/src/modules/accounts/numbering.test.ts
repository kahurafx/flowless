import { CHECK_DIGIT_SCHEMES } from "@flowless/shared-types";
import { describe, expect, it } from "vitest";
import {
  checkDigitOf,
  childAccountNumber,
  DEFAULT_NUMBERING,
  formatAccountNumber,
  hasValidCheckDigit,
  numberingFormatSchema,
  parseAccountNumber,
  suffixIndexOf,
  suffixLetters,
  type NumberingFormat,
} from "./numbering";

// C-02: account numbers with a check digit, configurable format, parent/child letters.
const fmt = (over: Partial<NumberingFormat> = {}): NumberingFormat => ({ ...DEFAULT_NUMBERING, ...over });

describe("check digits", () => {
  it("luhn matches the published example (7992739871 → 3)", () => {
    expect(checkDigitOf("7992739871", "luhn")).toBe("3");
    expect(hasValidCheckDigit("79927398713", "luhn")).toBe(true);
    expect(hasValidCheckDigit("79927398714", "luhn")).toBe(false);
  });

  it("luhn and mod11 agree with hand-worked values for 1008", () => {
    expect(checkDigitOf("1008", "luhn")).toBe("2");
    expect(checkDigitOf("1008", "mod11")).toBe("1");
    expect(hasValidCheckDigit("10082", "luhn")).toBe(true);
    expect(hasValidCheckDigit("10081", "mod11")).toBe(true);
  });

  it("mod11 has no digit for one body in eleven, and none appends nothing", () => {
    expect(checkDigitOf("6", "mod11")).toBeNull();
    expect(checkDigitOf("1008", "none")).toBe("");
    expect(hasValidCheckDigit("1008", "none")).toBe(true);
  });

  it("rejects non-digits and too-short numbers", () => {
    expect(hasValidCheckDigit("10A82", "luhn")).toBe(false);
    expect(hasValidCheckDigit("2", "luhn")).toBe(false);
    expect(() => checkDigitOf("10A", "luhn")).toThrow();
  });

  const digitsOf = (n: number) => String(n).padStart(5, "0");

  for (const scheme of ["luhn", "mod11"] as const) {
    describe(scheme, () => {
      // Every body from 0 to 19999 (when it has a check digit) validates, and no single-digit change does.
      it("every generated number validates and every single-digit change is detected", () => {
        let checked = 0;
        for (let n = 0; n < 20_000; n++) {
          const body = digitsOf(n);
          const check = checkDigitOf(body, scheme);
          if (check === null) continue;
          const whole = body + check;
          expect(hasValidCheckDigit(whole, scheme)).toBe(true);
          for (let i = 0; i < whole.length; i++) {
            for (let d = 0; d <= 9; d++) {
              if (String(d) === whole[i]) continue;
              expect(hasValidCheckDigit(whole.slice(0, i) + d + whole.slice(i + 1), scheme)).toBe(false);
              checked++;
            }
          }
        }
        expect(checked).toBeGreaterThan(900_000);
      });

      it("every adjacent transposition is detected (luhn: except 09 and 90)", () => {
        let swaps = 0;
        for (let n = 0; n < 20_000; n++) {
          const body = digitsOf(n);
          const check = checkDigitOf(body, scheme);
          if (check === null) continue;
          const whole = body + check;
          for (let i = 0; i + 1 < whole.length; i++) {
            const a = whole[i]!;
            const b = whole[i + 1]!;
            if (a === b) continue;
            const swapped = whole.slice(0, i) + b + a + whole.slice(i + 2);
            const known = scheme === "luhn" && ((a === "0" && b === "9") || (a === "9" && b === "0"));
            expect(hasValidCheckDigit(swapped, scheme)).toBe(known);
            swaps++;
          }
        }
        expect(swaps).toBeGreaterThan(50_000);
      });

      it("holds for long and pseudo-random numbers too", () => {
        let seed = 12345;
        const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
        for (let k = 0; k < 2000; k++) {
          const length = 2 + (next() % 14);
          let body = "";
          for (let i = 0; i < length; i++) body += String(next() % 10);
          const check = checkDigitOf(body, scheme);
          if (check === null) continue;
          const whole = body + check;
          expect(hasValidCheckDigit(whole, scheme)).toBe(true);
          const i = next() % whole.length;
          const wrong = String((Number(whole[i]) + 1 + (next() % 9)) % 10);
          expect(hasValidCheckDigit(whole.slice(0, i) + wrong + whole.slice(i + 1), scheme)).toBe(false);
        }
      });
    });
  }
});

describe("child letters", () => {
  it("counts A to Z, then AA", () => {
    expect([1, 2, 26, 27, 28, 52, 53, 702, 703].map(suffixLetters)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });

  it("round-trips for the first 20000 children", () => {
    for (let i = 1; i <= 20_000; i++) expect(suffixIndexOf(suffixLetters(i))).toBe(i);
    expect(suffixIndexOf("")).toBeNull();
    expect(suffixIndexOf("a1")).toBeNull();
    expect(() => suffixLetters(0)).toThrow();
  });

  it("extends the parent's number", () => {
    expect(childAccountNumber("10082", 2)).toBe("10082B");
  });
});

describe("formatAccountNumber", () => {
  it("pads the sequence and appends the check digit", () => {
    expect(formatAccountNumber(1008, fmt())).toBe("10082");
    expect(formatAccountNumber(7, fmt())).toBe("00075");
    expect(formatAccountNumber(1008, fmt({ checkDigit: "none" }))).toBe("1008");
    expect(formatAccountNumber(1008, fmt({ checkDigit: "mod11" }))).toBe("10081");
    expect(formatAccountNumber(123_456, fmt())).toMatch(/^123456\d$/);
  });

  it("joins prefix, sequence and check digit with the separator, only between parts that exist", () => {
    expect(formatAccountNumber(1008, fmt({ prefix: "KW", separator: "-" }))).toBe("KW-1008-2");
    expect(formatAccountNumber(1008, fmt({ separator: "-" }))).toBe("1008-2");
    expect(formatAccountNumber(1008, fmt({ prefix: "KW", separator: "-", checkDigit: "none" }))).toBe("KW-1008");
    expect(formatAccountNumber(1008, fmt({ prefix: "KW" }))).toBe("KW10082");
  });

  it("returns null where mod 11 has no digit, and refuses a bad sequence", () => {
    expect(formatAccountNumber(6, fmt({ checkDigit: "mod11", width: 1 }))).toBeNull();
    expect(() => formatAccountNumber(0, fmt())).toThrow();
    expect(() => formatAccountNumber(1.5, fmt())).toThrow();
  });
});

describe("parseAccountNumber", () => {
  const formats: [string, NumberingFormat][] = [
    ["plain luhn", fmt()],
    ["plain mod11", fmt({ checkDigit: "mod11" })],
    ["no check digit", fmt({ checkDigit: "none" })],
    ["prefix", fmt({ prefix: "KW" })],
    ["prefix and separator", fmt({ prefix: "KW", separator: "-" })],
    ["numeric prefix", fmt({ prefix: "20", width: 6 })],
    ["separator only", fmt({ separator: "/", checkDigit: "mod11" })],
    ["wide", fmt({ width: 9, prefix: "A", separator: "." })],
  ];

  for (const [name, format] of formats) {
    it(`${name}: every generated number parses back to its sequence, with and without child letters`, () => {
      for (let seq = 1; seq <= 3000; seq++) {
        const number = formatAccountNumber(seq, format);
        if (number === null) continue;
        const parsed = parseAccountNumber(number, format);
        expect(parsed).toEqual({ ok: true, base: number, sequence: seq, suffix: "", suffixIndex: null });
        expect(parseAccountNumber(` ${number.toLowerCase()} `, format)).toMatchObject({ ok: true, sequence: seq });
        expect(parseAccountNumber(childAccountNumber(number, 3), format)).toMatchObject({ ok: true, base: number, suffix: "C", suffixIndex: 3 });
      }
    });
  }

  it("rejects a wrong check digit, a wrong prefix, a missing separator and short numbers", () => {
    expect(parseAccountNumber("10083", fmt())).toMatchObject({ ok: false, reason: expect.stringContaining("check digit") });
    expect(parseAccountNumber("XX10082", fmt({ prefix: "KW" }))).toMatchObject({ ok: false });
    expect(parseAccountNumber("KW10082", fmt({ prefix: "KW", separator: "-" }))).toMatchObject({ ok: false });
    expect(parseAccountNumber("102", fmt())).toMatchObject({ ok: false });
    expect(parseAccountNumber("ABC", fmt())).toMatchObject({ ok: false });
    expect(parseAccountNumber("", fmt())).toMatchObject({ ok: false });
    expect(parseAccountNumber("1008-2", fmt())).toMatchObject({ ok: false });
  });

  it("detects a mistyped digit anywhere in a prefixed, separated number", () => {
    const format = fmt({ prefix: "KW", separator: "-", checkDigit: "mod11" });
    const number = formatAccountNumber(4242, format)!;
    const digitAt = [...number].flatMap((ch, i) => (/\d/.test(ch) && i >= 3 ? [i] : []));
    for (const i of digitAt) {
      const wrong = String((Number(number[i]) + 1) % 10);
      expect(parseAccountNumber(number.slice(0, i) + wrong + number.slice(i + 1), format).ok).toBe(false);
    }
  });
});

describe("numberingFormatSchema", () => {
  it("defaults every field, so a stored older version still reads", () => {
    expect(numberingFormatSchema.parse({})).toEqual({ prefix: "", width: 4, start: 1001, checkDigit: "luhn", separator: "", childSuffix: "letters" });
    expect(numberingFormatSchema.parse({ prefix: "KW" }).checkDigit).toBe("luhn");
  });

  it("refuses prefixes and separators that would be ambiguous", () => {
    expect(numberingFormatSchema.safeParse({ prefix: "kw" }).success).toBe(false);
    expect(numberingFormatSchema.safeParse({ separator: "ab" }).success).toBe(false);
    expect(numberingFormatSchema.safeParse({ width: 0 }).success).toBe(false);
    expect(numberingFormatSchema.safeParse({ checkDigit: "crc" }).success).toBe(false);
    for (const checkDigit of CHECK_DIGIT_SCHEMES) expect(numberingFormatSchema.safeParse({ checkDigit }).success).toBe(true);
  });
});
