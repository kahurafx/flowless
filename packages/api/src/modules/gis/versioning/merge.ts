/**
 * Three-way merge for one versioned entity — the decision logic behind
 * reconciling a branch onto main, kept free of any database access so every
 * case can be tested directly.
 *
 * The three inputs are the entity as it was when the branch forked (`base`),
 * as the branch has it now (`branch`), and as main has it now (`main`).
 * Merging per FIELD rather than per row is what lets two people edit
 * different attributes of the same asset without anyone being asked to
 * resolve anything.
 */

export const EXISTENCE_FIELD = "__existence__";

export type Side = "branch" | "main";
/** field name → which side wins. `EXISTENCE_FIELD` covers delete-versus-edit. */
export type Resolutions = Record<string, Side>;

export type MergeRow = { isDeleted: boolean } & Record<string, unknown>;

export type Conflict = { field: string; base: unknown; branch: unknown; main: unknown };

export type MergePlan =
  | { kind: "skip"; reason: "created-and-deleted-on-branch" | "no-change" | "kept-main" }
  | {
      kind: "write";
      mode: "create" | "fast-forward" | "merge" | "delete" | "restore";
      /** Final value of every mergeable field (empty for a plain delete). */
      values: Record<string, unknown>;
      tombstone: boolean;
      /** Fields whose final value differs from what main has right now. */
      changedFields: string[];
    }
  | { kind: "conflict"; conflicts: Conflict[] };

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    return aKeys.every((k) => valuesEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

function pick(row: MergeRow, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f, row[f]]));
}

function differing(a: MergeRow, b: MergeRow, fields: readonly string[]): string[] {
  return fields.filter((f) => !valuesEqual(a[f], b[f]));
}

function asSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.map(String) : []);
}

/**
 * Three-way merge of a set: start from what main has now, add what the branch
 * added, drop what the branch removed. Additions can't contradict removals
 * (you can only add what the fork didn't have and only remove what it did), so
 * unlike a scalar this can never conflict. Returned sorted, so two equal sets
 * always compare equal.
 */
function mergeSets(base: Set<string>, branch: Set<string>, main: Set<string>): string[] {
  const merged = new Set(main);
  for (const item of branch) if (!base.has(item)) merged.add(item);
  for (const item of base) if (!branch.has(item)) merged.delete(item);
  return [...merged].sort();
}

export function planMerge(
  input: { base: MergeRow | null; branch: MergeRow; main: MergeRow | null },
  fields: readonly string[],
  resolutions: Resolutions = {},
  options: { setFields?: readonly string[] } = {},
): MergePlan {
  const { base, branch, main } = input;
  const setFields = new Set(options.setFields ?? []);

  // The entity only ever existed on the branch.
  if (!main) {
    if (branch.isDeleted) return { kind: "skip", reason: "created-and-deleted-on-branch" };
    return { kind: "write", mode: "create", values: pick(branch, fields), tombstone: false, changedFields: [...fields] };
  }

  if (!base) {
    // A branch-created entity can't already be on main (ids are unique across the registry),
    // so this means the data is inconsistent — fail loudly rather than guess.
    throw new Error("Entity was created on a branch but already exists on main");
  }

  if (branch.isDeleted) {
    if (main.isDeleted) return { kind: "skip", reason: "no-change" };
    if (differing(base, main, fields).length === 0) {
      return { kind: "write", mode: "delete", values: {}, tombstone: true, changedFields: [] };
    }
    // Branch deleted it, main edited it since: someone has to decide.
    const side = resolutions[EXISTENCE_FIELD];
    if (!side) {
      return {
        kind: "conflict",
        conflicts: [{ field: EXISTENCE_FIELD, base: "present", branch: "deleted", main: "edited" }],
      };
    }
    return side === "branch" ? { kind: "write", mode: "delete", values: {}, tombstone: true, changedFields: [] } : { kind: "skip", reason: "kept-main" };
  }

  if (main.isDeleted) {
    // Branch edited it, main deleted it since.
    const side = resolutions[EXISTENCE_FIELD];
    if (!side) {
      return {
        kind: "conflict",
        conflicts: [{ field: EXISTENCE_FIELD, base: "present", branch: "edited", main: "deleted" }],
      };
    }
    return side === "main"
      ? { kind: "skip", reason: "kept-main" }
      : {
          kind: "write",
          mode: "restore",
          values: pick(branch, fields),
          tombstone: false,
          changedFields: differing(branch, main, fields),
        };
  }

  // Both sides alive: merge field by field.
  const values: Record<string, unknown> = {};
  const conflicts: Conflict[] = [];

  for (const field of fields) {
    const baseValue = base[field];
    const branchValue = branch[field];
    const mainValue = main[field];

    if (setFields.has(field)) {
      values[field] = mergeSets(asSet(baseValue), asSet(branchValue), asSet(mainValue));
      continue;
    }

    const branchChanged = !valuesEqual(baseValue, branchValue);
    const mainChanged = !valuesEqual(baseValue, mainValue);

    if (!branchChanged) values[field] = mainValue;
    else if (!mainChanged) values[field] = branchValue;
    else if (valuesEqual(branchValue, mainValue))
      values[field] = mainValue; // same edit on both sides
    else {
      const side = resolutions[field];
      if (!side) conflicts.push({ field, base: baseValue, branch: branchValue, main: mainValue });
      else values[field] = side === "branch" ? branchValue : mainValue;
    }
  }

  if (conflicts.length > 0) return { kind: "conflict", conflicts };

  const changedFields = fields.filter((f) => !valuesEqual(values[f], main[f]));
  if (changedFields.length === 0) return { kind: "skip", reason: "no-change" };

  const mainUnchangedSinceFork = differing(base, main, fields).length === 0;
  return {
    kind: "write",
    mode: mainUnchangedSinceFork ? "fast-forward" : "merge",
    values,
    tombstone: false,
    changedFields,
  };
}
