/**
 * What changed between two versions of a list, by object identity. State updates keep the objects they
 * didn't touch, so recording one inspection writes one row, not the whole network. Pure, so it is
 * testable without a device.
 */
export function diffRows<T>(previous: readonly T[], next: readonly T[], keyOf: (row: T) => string): { upserts: T[]; deletes: string[] } {
  if (previous === next) return { upserts: [], deletes: [] };
  const before = new Map(previous.map((row): [string, T] => [keyOf(row), row]));
  const upserts: T[] = [];
  const kept = new Set<string>();
  for (const row of next) {
    const key = keyOf(row);
    kept.add(key);
    if (before.get(key) !== row) upserts.push(row);
  }
  const deletes = [...before.keys()].filter((key) => !kept.has(key));
  return { upserts, deletes };
}
