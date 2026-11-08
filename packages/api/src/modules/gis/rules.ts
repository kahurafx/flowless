import type { Transaction } from "@flowless/db";
import { structureAttachmentRule } from "@flowless/db/schema/gis";
import { NODE_TYPES, STRUCTURE_ATTACHMENT_RULES, type NodeType, type StructureType } from "@flowless/shared-types";

/*
 * Structure-attachment rules (G-01): which structure types each node type may be housed
 * in, per organization (NF-32). The `gis.check_structure_attachment` trigger enforces them
 * on every write; the API checks first with a friendlier message.
 */

const DEFAULT_ROWS = NODE_TYPES.flatMap((nodeType) => STRUCTURE_ATTACHMENT_RULES[nodeType].map((structureType) => ({ nodeType, structureType })));

/**
 * Gives an organization the default rules if it has none (on licensing GIS, and on first
 * use as a backstop). An organization's rules are never emptied by hand (`set` refuses
 * that), so "no rules" always means "never seeded".
 */
export async function ensureAttachmentRules(tx: Transaction, organizationId: string): Promise<boolean> {
  const [any] = await tx.select({ nodeType: structureAttachmentRule.nodeType }).from(structureAttachmentRule).limit(1);
  if (any) return false;
  await tx
    .insert(structureAttachmentRule)
    .values(DEFAULT_ROWS.map((r) => ({ ...r, organizationId })))
    .onConflictDoNothing();
  return true;
}

/** The organization's rules, every node type listed (empty when it may be housed nowhere). */
export async function loadAttachmentRules(tx: Transaction): Promise<Record<NodeType, StructureType[]>> {
  const rows = await tx.select().from(structureAttachmentRule);
  const rules = Object.fromEntries(NODE_TYPES.map((t) => [t, [] as StructureType[]])) as Record<NodeType, StructureType[]>;
  for (const row of rows) rules[row.nodeType].push(row.structureType);
  for (const list of Object.values(rules)) list.sort();
  return rules;
}

export async function attachmentAllowed(tx: Transaction, nodeType: NodeType, structureType: StructureType): Promise<boolean> {
  return (await loadAttachmentRules(tx))[nodeType].includes(structureType);
}
