/** Money is bigint minor units. Floats never touch an amount. */
export type Minor = bigint;

export const sum = <T>(xs: readonly T[], f: (x: T) => bigint): bigint => xs.reduce((s, x) => s + f(x), 0n);

/** num / den rounded half away from zero; `den` must be positive. The one rounding a line gets. */
export function roundDiv(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError("roundDiv: denominator must be positive");
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = (2n * a + den) / (2n * den);
  return neg ? -q : q;
}

/** Units (readings, consumption) are whole numbers; anything else is a caller bug. */
export function assertWhole(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} must be a whole number, got ${n}`);
}
