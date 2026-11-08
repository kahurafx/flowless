import type { Permission } from "@flowless/shared-types";
import type { WorkRegistry } from "../../kernel/work";
import { moduleProcedure } from "../../trpc";
import { ensureAttachmentRules } from "./rules";

/**
 * The GIS procedures (K-04, NF-03), Flowless permissions in place of Majimap's roles:
 * - `read` (`gis:read`): the network, its history, traces, logs, branches and previews.
 * - `edit` (`gis:edit`): proposals on branches the caller may write (Majimap's write roles).
 *   Main needs `gis:post` as well, checked per branch (`assertBranchWritable`).
 * - `remove` (`gis:delete`): deleting, restoring and the delete-impact preview.
 * - `post` (`gis:post`): posting a branch to main, discarding it.
 * - `configure` (`gis:configure`): tiers, subnetworks and attachment rules.
 * Every write procedure seeds the organization's attachment rules on first use.
 */
export function gisProcedures(work: WorkRegistry) {
  const base = moduleProcedure("gis", "gis:read").use(({ next }) => next({ ctx: { work } }));
  const writing = (permission: Permission) =>
    moduleProcedure("gis", "gis:read", permission).use(async ({ ctx, next, type }) => {
      if (type !== "query") await ensureAttachmentRules(ctx.tx, ctx.organizationId);
      return next({ ctx: { work } });
    });
  return {
    read: base,
    edit: writing("gis:edit"),
    remove: writing("gis:delete"),
    post: writing("gis:post"),
    configure: writing("gis:configure"),
  };
}

export type GisProcedures = ReturnType<typeof gisProcedures>;
