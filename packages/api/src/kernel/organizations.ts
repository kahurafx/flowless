import { organizationSettings } from "@flowless/db";
import { TRPCError } from "@trpc/server";
import { router, tenantProcedure } from "../trpc";

export const organizationsRouter = router({
  /** The caller's organization settings (NF-33, B-18). RLS makes it the only row visible. */
  settings: tenantProcedure.query(async ({ ctx }) => {
    const [settings] = await ctx.tx.select().from(organizationSettings);
    if (!settings) throw new TRPCError({ code: "NOT_FOUND" });
    return settings;
  }),
});
