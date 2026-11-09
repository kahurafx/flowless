import { numberingFormatSchema, type CheckDigitScheme, type NumberingFormat } from "@flowless/shared-types";

// The format schema is shared with the web form (`@flowless/shared-types`); the module keeps exporting it.
export { numberingFormatSchema, type NumberingFormat };

/*
 * Account numbers (C-02): format, check digits and parent/child letters. Pure: no I/O, no
 * clock, so every rule is tested exhaustively without a database. The sequence itself is
 * allocated by `service.ts` (a locked counter row); this file only says what a number looks
 * like and whether one is well formed.
 *
 *   number = [prefix] SEP sequence (zero-padded to `width`) SEP checkdigit
 *   child  = parent number + letters      1008B (second child of 1008)
 *
 * Separators appear only between the parts that are present. The check digit covers the
 * sequence digits only, so a prefix or separator can change without invalidating numbers.
 */

export const DEFAULT_NUMBERING: NumberingFormat = numberingFormatSchema.parse({});

/* ---------- check digits ---------- */

const isDigits = (s: string) => /^\d+$/.test(s);

/** Luhn: from the right, every second digit (starting with the one next to the check digit) is doubled. */
function luhnSum(digits: string, doubleFirst: boolean): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if ((i % 2 === 0) === doubleFirst) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum;
}

/**
 * Mod 11 with weights 1, 2, ... 10 from the right and the check digit at weight 1: the
 * weighted sum of the whole number is a multiple of 11. Weights are never 0 mod 11 and
 * neighbours differ, so every single-digit error and every adjacent swap changes the sum.
 */
function mod11Sum(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) sum += Number(digits[digits.length - 1 - i]) * ((i % 10) + 1);
  return sum;
}

/**
 * The check digit for `body` (digits only), or null when the scheme has none for it: mod 11
 * needs the digit 10 for one body in eleven, which is skipped (the allocator takes the next
 * sequence). "" for `none`.
 */
export function checkDigitOf(body: string, scheme: CheckDigitScheme): string | null {
  if (scheme === "none") return "";
  if (!isDigits(body)) throw new Error(`Check digits are computed over digits, got "${body}"`);
  if (scheme === "luhn") return String((10 - (luhnSum(body, true) % 10)) % 10);
  const check = (11 - (mod11Sum(`${body}0`) % 11)) % 11;
  return check === 10 ? null : String(check);
}

/** Is `digits` (body plus check digit) consistent under the scheme? `none` accepts any digits. */
export function hasValidCheckDigit(digits: string, scheme: CheckDigitScheme): boolean {
  if (!isDigits(digits)) return false;
  if (scheme === "none") return true;
  if (digits.length < 2) return false;
  return scheme === "luhn" ? luhnSum(digits, false) % 10 === 0 : mod11Sum(digits) % 11 === 0;
}

/* ---------- child letters ---------- */

/** 1 → A, 26 → Z, 27 → AA, 28 → AB (spreadsheet columns). */
export function suffixLetters(index: number): string {
  if (!Number.isInteger(index) || index < 1) throw new Error("A child's letter index starts at 1");
  let letters = "";
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

/** The inverse of `suffixLetters`; null for anything that is not capital letters. */
export function suffixIndexOf(letters: string): number | null {
  if (!/^[A-Z]+$/.test(letters)) return null;
  return [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
}

/* ---------- generate and parse ---------- */

/** The number for sequence `sequence`, or null when it has no valid check digit (mod 11, one in eleven). */
export function formatAccountNumber(sequence: number, format: NumberingFormat): string | null {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("A sequence starts at 1");
  const body = String(sequence).padStart(format.width, "0");
  const check = checkDigitOf(body, format.checkDigit);
  if (check === null) return null;
  return [format.prefix, body, check].filter((part) => part !== "").join(format.separator);
}

/** A child's number: its parent's plus the letters for its place under it ("1008" + 2 → "1008B"). */
export function childAccountNumber(parentNumber: string, index: number): string {
  return `${parentNumber}${suffixLetters(index)}`;
}

export type ParsedAccountNumber =
  | {
      ok: true;
      /** The number without child letters. */
      base: string;
      sequence: number;
      /** Child letters, "" for a top-level number. */
      suffix: string;
      suffixIndex: number | null;
    }
  | { ok: false; reason: string };

/**
 * Does `raw` match the format, with a correct check digit? Case and surrounding spaces are
 * ignored. Child letters after the number are accepted and returned.
 */
export function parseAccountNumber(raw: string, format: NumberingFormat): ParsedAccountNumber {
  const number = raw.trim().toUpperCase();
  const split = /^(.*\d)([A-Z]*)$/.exec(number);
  if (!split) return { ok: false, reason: "An account number ends in a digit, or in letters after one" };
  const base = split[1]!;
  const suffix = split[2]!;
  if (!base.startsWith(format.prefix)) return { ok: false, reason: `Account numbers start with ${format.prefix}` };
  let rest = base.slice(format.prefix.length);
  if (format.prefix !== "" && format.separator !== "") {
    if (!rest.startsWith(format.separator)) return { ok: false, reason: `Expected "${format.separator}" after the prefix` };
    rest = rest.slice(format.separator.length);
  }

  let body: string;
  let check = "";
  if (format.checkDigit === "none") {
    body = rest;
  } else if (format.separator !== "") {
    const at = rest.lastIndexOf(format.separator);
    if (at < 0) return { ok: false, reason: `Expected "${format.separator}" before the check digit` };
    body = rest.slice(0, at);
    check = rest.slice(at + format.separator.length);
  } else {
    body = rest.slice(0, -1);
    check = rest.slice(-1);
  }
  if (!isDigits(body) || body.length < format.width || (format.checkDigit !== "none" && !/^\d$/.test(check))) {
    return { ok: false, reason: `Expected at least ${format.width} digits` };
  }
  if (format.checkDigit !== "none" && !hasValidCheckDigit(body + check, format.checkDigit)) {
    return { ok: false, reason: "The check digit does not match: look for a mistyped digit" };
  }
  return { ok: true, base, sequence: Number(body), suffix, suffixIndex: suffix === "" ? null : suffixIndexOf(suffix) };
}

export const isValidAccountNumber = (raw: string, format: NumberingFormat) => parseAccountNumber(raw, format).ok;
