/** A parent-linked list as depth-first rows with their depth, children in `compare` order. */
export function flattenTree<T extends { id: string; parentId: string | null }>(
  items: readonly T[],
  compare: (a: T, b: T) => number,
): { item: T; depth: number }[] {
  const ids = new Set(items.map((i) => i.id));
  const children = new Map<string | null, T[]>();
  for (const item of items) {
    // A parent outside the list (archived and hidden) puts the item at the top.
    const key = item.parentId && ids.has(item.parentId) ? item.parentId : null;
    children.set(key, [...(children.get(key) ?? []), item]);
  }
  const rows: { item: T; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const item of (children.get(parentId) ?? []).sort(compare)) {
      rows.push({ item, depth });
      walk(item.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}
