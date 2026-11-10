/** A billing period is a calendar month, `YYYY-MM`. The engine has no clock; callers pass periods in. */
export type Period = string;

export function periodIndex(p: Period): number {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(p);
  if (!m) throw new RangeError(`Invalid period "${p}", expected YYYY-MM`);
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

export function periodFromIndex(i: number): Period {
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}
