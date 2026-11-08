import type { Transaction } from "@flowless/db";
import { dmaBoundaryValve } from "@flowless/db/schema/gis";
import { inArray } from "drizzle-orm";
import { areasById } from "../../kernel/areas";

/*
 * A DMA's boundary valves live in their own table, and each row belongs to ONE VERSION of
 * the DMA's map data (`dma_version_id`), not to the DMA in the abstract. That's what lets
 * main and a branch hold different valve sets for the same DMA at the same time. Every
 * new version needs its own full set, copied from the version it replaces unless the edit
 * supplies a new one. Old versions keep theirs, as history.
 */

/** Each version's boundary valves, sorted so two equal sets always compare equal. */
export async function loadBoundaryValves(tx: Transaction, versionIds: readonly string[]): Promise<Map<string, string[]>> {
  const byVersion = new Map<string, string[]>();
  if (versionIds.length === 0) return byVersion;
  const rows = await tx
    .select({ versionId: dmaBoundaryValve.dmaVersionId, valveId: dmaBoundaryValve.valveId })
    .from(dmaBoundaryValve)
    .where(inArray(dmaBoundaryValve.dmaVersionId, [...versionIds]));
  for (const row of rows) byVersion.set(row.versionId, [...(byVersion.get(row.versionId) ?? []), row.valveId]);
  for (const valves of byVersion.values()) valves.sort();
  return byVersion;
}

export async function writeBoundaryValves(tx: Transaction, organizationId: string, versionId: string, valveIds: readonly string[]) {
  const unique = [...new Set(valveIds)];
  if (unique.length === 0) return;
  await tx.insert(dmaBoundaryValve).values(unique.map((valveId) => ({ organizationId, dmaVersionId: versionId, valveId })));
}

/** A DMA is named by its kernel area (K-02). */
export async function areaNames(tx: Transaction, areaIds: readonly string[]): Promise<Map<string, string>> {
  return new Map([...(await areasById(tx, areaIds)).values()].map((a) => [a.id, a.name]));
}
