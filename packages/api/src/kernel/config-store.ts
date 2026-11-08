import { configVersion, type Transaction } from "@flowless/db";
import type { ModuleKey } from "@flowless/shared-types";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { z } from "zod";

/**
 * A setting in the configuration store (K-10, NF-32): defined in code by the module that
 * owns it, valued per organization. Keep `schema` able to read every version ever stored
 * (add fields with `.default()`), because old versions stay readable for past runs.
 */
export interface SettingDef<T = unknown> {
  /** "<module>.<setting>", unique. */
  readonly key: string;
  /** Hidden and not settable while this module is unlicensed (K-04). */
  readonly module: ModuleKey | "kernel";
  readonly label: string;
  readonly description: string;
  readonly schema: z.ZodType<T>;
  /** The value until the organization sets one. */
  readonly default: T;
}

export function defineSetting<T>(def: SettingDef<T>): SettingDef<T> {
  return def;
}

export interface SettingValue<T> {
  value: T;
  /** 0 while the default applies. */
  version: number;
  effectiveFrom: Date | null;
}

function parse<T>(def: SettingDef<T>, stored: unknown): T {
  const parsed = def.schema.safeParse(stored);
  if (!parsed.success) throw new Error(`Stored value of setting ${def.key} no longer matches its schema`);
  return parsed.data;
}

/** The value in force at `at` (default now) for the transaction's organization. */
export async function readSetting<T>(tx: Transaction, def: SettingDef<T>, at: Date = new Date()): Promise<SettingValue<T>> {
  const [row] = await tx
    .select({ value: configVersion.value, version: configVersion.version, effectiveFrom: configVersion.effectiveFrom })
    .from(configVersion)
    .where(and(eq(configVersion.key, def.key), lte(configVersion.effectiveFrom, at)))
    .orderBy(desc(configVersion.effectiveFrom), desc(configVersion.version))
    .limit(1);
  if (!row) return { value: def.default, version: 0, effectiveFrom: null };
  return { value: parse(def, row.value), version: row.version, effectiveFrom: row.effectiveFrom };
}

/** The newest version number for a key, whether in force yet or scheduled; 0 if none. */
export async function latestVersion(tx: Transaction, key: string): Promise<number> {
  const [row] = await tx
    .select({ version: sql<number>`coalesce(max(${configVersion.version}), 0)::int` })
    .from(configVersion)
    .where(eq(configVersion.key, key));
  return row?.version ?? 0;
}

export interface WriteSetting<T> {
  value: T;
  /** Default now. */
  effectiveFrom?: Date;
  reason?: string | null;
  createdByUserId?: string | null;
  /** Version number to write; default the next one. */
  version?: number;
}

/**
 * Appends a version. The unique (organization, key, version) constraint rejects a
 * concurrent writer of the same version; callers turn that into a conflict.
 */
export async function writeSetting<T>(tx: Transaction, organizationId: string, def: SettingDef<T>, input: WriteSetting<T>) {
  const version = input.version ?? (await latestVersion(tx, def.key)) + 1;
  const [row] = await tx
    .insert(configVersion)
    .values({
      organizationId,
      key: def.key,
      version,
      value: def.schema.parse(input.value) as object,
      effectiveFrom: input.effectiveFrom ?? new Date(),
      reason: input.reason ?? null,
      createdByUserId: input.createdByUserId ?? null,
    })
    .onConflictDoNothing()
    .returning({ version: configVersion.version });
  return row ?? null;
}
