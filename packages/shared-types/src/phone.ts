/**
 * Phone numbers (C-01). Pure and platform-neutral: the API stores the result, the data
 * quality rules (C-12) and the apps read it. Numbers are held as digits in international
 * format without the plus sign ("254712345678"); a placeholder such as 25400000000 or
 * 0777777777 means "no phone" and is never stored as a number.
 */

/** Calling codes by region, for the organization's default country (from `kernel.regional`'s locale). */
export const CALLING_CODES: Readonly<Record<string, string>> = { KE: "254", TZ: "255", UG: "256", RW: "250", ET: "251" };
export const DEFAULT_CALLING_CODE = "254";

/** The calling code of a locale such as "en-KE" or "sw-TZ"; Kenya's when the region is unknown. */
export function callingCodeOf(locale: string | null | undefined): string {
  const region = locale
    ?.split("-")
    .find((part, i) => i > 0 && /^[A-Za-z]{2}$/.test(part))
    ?.toUpperCase();
  return (region && CALLING_CODES[region]) || DEFAULT_CALLING_CODE;
}

export type PhoneParse =
  /** `digits` is international format without "+", comparable across spellings. */
  | { kind: "valid"; digits: string }
  /** Empty, or nothing but zeros or one repeated digit after the country code: counts as no phone. */
  | { kind: "placeholder" }
  | { kind: "invalid"; reason: string };

/** Length of the national part for the countries above (mobile and landline alike). */
const NATIONAL_LENGTH = 9;

const allSameDigit = (digits: string) => /^(\d)\1*$/.test(digits);

/**
 * Normalises what a person typed. Accepts "0712 345 678", "+254 712-345-678",
 * "254712345678", "712345678" and "00254712345678". Another country's number is accepted
 * when written in full international form ("+" or "00"), as 8 to 15 digits.
 */
export function parsePhone(raw: string | null | undefined, callingCode: string = DEFAULT_CALLING_CODE): PhoneParse {
  const typed = (raw ?? "").trim();
  if (typed === "") return { kind: "placeholder" };
  if (/[^\d\s\-().+]/.test(typed) || typed.lastIndexOf("+") > 0) return { kind: "invalid", reason: "A phone number has digits only" };
  const international = typed.startsWith("+");
  let digits = typed.replace(/\D/g, "");
  if (digits === "") return { kind: "placeholder" };

  let explicit = international;
  if (!international && digits.startsWith("00") && !allSameDigit(digits)) {
    digits = digits.slice(2);
    explicit = true;
  }
  if (!explicit) {
    if (digits.startsWith("0")) digits = callingCode + digits.slice(1);
    else if (!digits.startsWith(callingCode) && digits.length === NATIONAL_LENGTH) digits = callingCode + digits;
    else if (!digits.startsWith(callingCode)) {
      return allSameDigit(digits) ? { kind: "placeholder" } : { kind: "invalid", reason: "Not a valid phone number" };
    }
  }
  if (digits.startsWith(callingCode)) {
    const national = digits.slice(callingCode.length);
    if (national === "" || allSameDigit(national)) return { kind: "placeholder" };
    if (national.length !== NATIONAL_LENGTH || national.startsWith("0")) {
      return { kind: "invalid", reason: `A number here has ${NATIONAL_LENGTH} digits after +${callingCode}` };
    }
    return { kind: "valid", digits };
  }
  if (allSameDigit(digits)) return { kind: "placeholder" };
  if (!explicit || digits.length < 8 || digits.length > 15) return { kind: "invalid", reason: "Not a valid international phone number" };
  return { kind: "valid", digits };
}
