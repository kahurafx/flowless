import type { Transaction } from "@flowless/db";
import type { FileLimits, ModuleKey, Permission, Scope } from "@flowless/shared-types";

export interface FileSubjectContext {
  tx: Transaction;
  organizationId: string;
  userId: string;
  permissions: ReadonlySet<Permission>;
  scope(): Promise<Scope>;
}

/**
 * Something files can be attached to (K-08), registered by the module that owns it, so
 * the kernel never reads module tables. `authorize` checks the record exists in the
 * caller's organization and that they may read, add or remove its files; it throws
 * NOT_FOUND for a record the caller may not see, so ids cannot be probed. `manage` lets
 * the caller confirm or remove files someone else added.
 */
export interface FileSubjectDef {
  /** snake_case, unique, e.g. "work_order". */
  readonly kind: string;
  readonly module: ModuleKey | "kernel";
  readonly label: string;
  readonly limits?: Partial<FileLimits>;
  authorize(ctx: FileSubjectContext, subjectId: string, mode: "read" | "write" | "remove"): Promise<{ manage: boolean }>;
}

export function defineFileSubject(def: FileSubjectDef): FileSubjectDef {
  if (!/^[a-z][a-z0-9_]*$/.test(def.kind)) throw new Error(`File subject "${def.kind}" must be snake_case`);
  return def;
}

/** Every file subject. A module adds its own when it ships (work orders, assets, accounts). */
export const fileSubjects: readonly FileSubjectDef[] = [];
