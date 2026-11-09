import type { CheckDigitScheme } from "@flowless/shared-types";

/*
 * What account numbers would look like under a numbering format being edited (C-02): a
 * mirror of the Accounts module's pure `numbering.ts` (check digits and layout), so the
 * settings form can preview a draft without saving it. The API issues the real numbers;
 * `account-settings.test.ts` checks this mirror against `formatAccountNumber`.
 */

export interface NumberFormat {
  prefix: string;
  width: number;
  start: number;
  checkDigit: CheckDigitScheme;
  separator: string;
}

function luhnSum(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum;
}

function mod11Sum(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) sum += Number(digits[digits.length - 1 - i]) * ((i % 10) + 1);
  return sum;
}

/** The check digit for the digits of a sequence, or null when the scheme has none for it (mod 11 skips one body in eleven). */
export function checkDigitOf(body: string, scheme: CheckDigitScheme): string | null {
  if (scheme === "none") return "";
  if (scheme === "luhn") return String((10 - (luhnSum(body) % 10)) % 10);
  const check = (11 - (mod11Sum(`${body}0`) % 11)) % 11;
  return check === 10 ? null : String(check);
}

/** The number for a sequence, or null when it has no valid check digit. */
export function formatNumber(sequence: number, format: NumberFormat): string | null {
  const body = String(sequence).padStart(format.width, "0");
  const check = checkDigitOf(body, format.checkDigit);
  if (check === null) return null;
  return [format.prefix, body, check].filter((part) => part !== "").join(format.separator);
}

/** The first few numbers the format would issue from its start, skipping sequences with no valid check digit as the issuer does. */
export function sampleNumbers(format: NumberFormat, count = 3): string[] {
  const out: string[] = [];
  for (let sequence = format.start; out.length < count && sequence < format.start + 1000; sequence++) {
    const number = formatNumber(sequence, format);
    if (number !== null) out.push(number);
  }
  return out;
}
