import { file, type Transaction } from "@flowless/db";
import type { FileLimits, ModuleKey, Permission, Scope } from "@flowless/shared-types";
import { and, eq, inArray, like, sql } from "drizzle-orm";

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
  /** The subject is found while this module (or, for a list, any of them) is licensed. */
  readonly module: ModuleKey | readonly ModuleKey[] | "kernel";
  readonly label: string;
  readonly limits?: Partial<FileLimits>;
  authorize(ctx: FileSubjectContext, subjectId: string, mode: "read" | "write" | "remove"): Promise<{ manage: boolean }>;
}

export function defineFileSubject(def: FileSubjectDef): FileSubjectDef {
  if (!/^[a-z][a-z0-9_]*$/.test(def.kind)) throw new Error(`File subject "${def.kind}" must be snake_case`);
  return def;
}

/** Whether a subject's module is licensed. */
export function subjectLicensed(def: FileSubjectDef, licensed: readonly ModuleKey[]): boolean {
  if (def.module === "kernel") return true;
  const modules: readonly ModuleKey[] = typeof def.module === "string" ? [def.module] : def.module;
  return modules.some((m) => licensed.includes(m));
}

/**
 * Uploaded photos per record of one subject kind, for evidence checks (W-02): the kernel's
 * published read of its file rows, so a module never queries `kernel.file` itself.
 */
export async function photoCounts(tx: Transaction, subjectKind: string, subjectIds: readonly string[]): Promise<Map<string, number>> {
  if (subjectIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: file.subjectId, n: sql<number>`count(*)::int` })
    .from(file)
    .where(
      and(eq(file.subjectKind, subjectKind), inArray(file.subjectId, [...subjectIds]), eq(file.status, "uploaded"), like(file.mimeType, "image/%")),
    )
    .groupBy(file.subjectId);
  return new Map(rows.map((r) => [r.id, r.n]));
}
