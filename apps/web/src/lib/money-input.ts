import { currencyExponent, toDecimalString } from "@flowless/shared-types";

/*
 * Money typed into a form and money shown in one, as minor units (bigint), never a float.
 * The exponent comes from the currency (2 for KES, 0 for JPY). The API validates again.
 */

/**
 * Typed amount ("1,250.50") as minor units, or null when it is not an amount with at most
 * the currency's decimals. Zero is accepted only with `allowZero` (a rate of 0 is a free
 * band; a deposit of 0 is nothing).
 */
export function parseAmount(text: string, currency: string, options: { allowZero?: boolean } = {}): bigint | null {
  const exponent = currencyExponent(currency);
  const cleaned = text.trim().replace(/[,\s]/g, "");
  const match = (exponent === 0 ? /^(\d+)$/ : new RegExp(`^(\\d+)(?:\\.(\\d{1,${exponent}}))?$`)).exec(cleaned);
  if (!match) return null;
  const minor = BigInt(match[1]!) * 10n ** BigInt(exponent) + BigInt((match[2] ?? "").padEnd(exponent, "0") || "0");
  if (minor === 0n && !options.allowZero) return null;
  return minor;
}

/** Minor units as the text an input holds ("8250" in KES is "82.50"). */
export const amountText = (minor: bigint, currency: string): string => toDecimalString({ amountMinor: minor, currency });

/** Minor units from a stored decimal string of digits ("2500"), or null when it is not digits. */
export function minorFromDigits(digits: string): bigint | null {
  return /^\d+$/.test(digits) ? BigInt(digits) : null;
}
