import { structureAttachmentRule } from "@flowless/db/schema/gis";
import { NODE_TYPES, STRUCTURE_ATTACHMENT_RULES, STRUCTURE_TYPES } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { router } from "../../trpc";
import type { GisProcedures } from "./procedures";
import { loadAttachmentRules } from "./rules";

/**
 * The organization's structure-attachment rules (configuration, NF-32): which structure
 * types each node type may be housed in. Reading needs `gis:read`; changing them
 * `gis:configure`, audited. Nodes already housed are not re-checked; the trigger applies
 * the rules to every later write.
 */
export function attachmentRulesRouter(p: GisProcedures) {
  return router({
    /** The rules in force. Before the organization's first GIS write seeds them, that is the defaults. */
    list: p.read.query(async ({ ctx }) => {
      const rules = await loadAttachmentRules(ctx.tx);
      const seeded = Object.values(rules).some((list) => list.length > 0);
      return seeded ? rules : (Object.fromEntries(NODE_TYPES.map((t) => [t, [...STRUCTURE_ATTACHMENT_RULES[t]].sort()])) as typeof rules);
    }),

    /** Replace the structure types one node type may be housed in. */
    set: p.configure
      .input(z.object({ nodeType: z.enum(NODE_TYPES), structureTypes: z.array(z.enum(STRUCTURE_TYPES)).max(STRUCTURE_TYPES.length) }))
      .mutation(async ({ ctx, input }) => {
        const before = await loadAttachmentRules(ctx.tx);
        const wanted = [...new Set(input.structureTypes)].sort();
        if (before[input.nodeType].join() === wanted.join()) return before;
        const remaining = Object.entries(before).filter(([type]) => type !== input.nodeType).flatMap(([, list]) => list).length;
        // "No rules at all" is how an organization that was never seeded looks, so it can't be set on purpose.
        if (remaining === 0 && wanted.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "At least one node type must be allowed in some structure" });
        }
        await ctx.tx.delete(structureAttachmentRule).where(eq(structureAttachmentRule.nodeType, input.nodeType));
        if (wanted.length) {
          await ctx.tx
            .insert(structureAttachmentRule)
            .values(wanted.map((structureType) => ({ organizationId: ctx.organizationId, nodeType: input.nodeType, structureType })));
        }
        const after = await loadAttachmentRules(ctx.tx);
        await ctx.audit({
          action: "gis.attachment_rules.set",
          subjectType: "gis_attachment_rule",
          subjectId: input.nodeType,
          before: { structureTypes: before[input.nodeType] },
          after: { structureTypes: after[input.nodeType] },
        });
        return after;
      }),
  });
}
