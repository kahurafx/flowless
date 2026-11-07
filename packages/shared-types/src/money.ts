/** ISO 4217 code, for example "KES". */
export type CurrencyCode = string;

/**
 * Money in integer minor units with an explicit currency (B-18). Never a float:
 * `amountMinor` is a bigint, carried over tRPC by superjson.
 */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

export function money(amountMinor: bigint, currency: CurrencyCode): Money {
  return { amountMinor, currency };
}

/** Sums amounts of one currency. Mixing currencies is a programming error, so it throws. */
export function sumMoney(currency: CurrencyCode, amounts: readonly Money[]): Money {
  let total = 0n;
  for (const m of amounts) {
    if (m.currency !== currency) throw new Error(`Cannot add ${m.currency} to ${currency}`);
    total += m.amountMinor;
  }
  return money(total, currency);
}

/** Minor-unit exponent of a currency (2 for KES, 0 for JPY), from Intl's ISO 4217 data. */
export function currencyExponent(currency: CurrencyCode): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Exact decimal string, for example 12345n KES → "123.45". No float conversion. */
export function toDecimalString({ amountMinor, currency }: Money): string {
  const exponent = currencyExponent(currency);
  const sign = amountMinor < 0n ? "-" : "";
  const digits = (amountMinor < 0n ? -amountMinor : amountMinor).toString().padStart(exponent + 1, "0");
  return exponent === 0 ? sign + digits : `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/** Locale-aware display (NF-33). Intl formats the decimal string exactly, never via a float. */
export function formatMoney(value: Money, locale: string): string {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency: value.currency });
  return format.format(toDecimalString(value) as Intl.StringNumericLiteral);
}
