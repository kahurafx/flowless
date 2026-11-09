import { DATA_QUALITY_RULE_KEYS } from "@flowless/shared-types";
import { z } from "zod";
import { router } from "../../trpc";
import { customerDuplicates, findings, ruleList, summary } from "./data-quality";
import type { AccountsProcedures } from "./procedures";

/**
 * The data-quality procedures (C-12), mounted at `accounts.dataQuality`; all need
 * `accounts:read`, and a limited member only sees findings inside their scope (the same
 * visibility as the account lists). `rules` is the catalogue with this organization's
 * settings and whether a rule that waits on another module has its source; `summary` the
 * dashboard's numbers in one pass; `findings` one rule's accounts, paged by account number;
 * `customerDuplicates` the groups of customers sharing a phone, national id or registration
 * number. Rules are configured with the `accounts.data_quality` setting.
 */
export function dataQualityRouter(p: AccountsProcedures) {
  return router({
    rules: p.read.query(({ ctx }) => ruleList(ctx.tx)),

    summary: p.read.query(({ ctx }) => summary(ctx.tx, ctx.organizationId, ctx.viewer)),

    findings: p.read
      .input(z.object({ rule: z.enum(DATA_QUALITY_RULE_KEYS), after: z.string().trim().min(1).max(60).optional(), limit: z.number().int().min(1).max(200).default(50) }))
      .query(({ ctx, input }) => findings(ctx.tx, ctx.organizationId, ctx.viewer, input)),

    customerDuplicates: p.read
      .input(
        z
          .object({
            after: z.object({ matchedOn: z.enum(["national_id", "registration_number", "phone"]), key: z.string().max(100) }).optional(),
            limit: z.number().int().min(1).max(100).default(25),
          })
          .optional(),
      )
      .query(({ ctx, input }) => customerDuplicates(ctx.tx, ctx.viewer, { after: input?.after, limit: input?.limit ?? 25 })),
  });
}
