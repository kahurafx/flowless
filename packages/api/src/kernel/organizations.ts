import { organizationSettings } from "@flowless/db";
import { TRPCError } from "@trpc/server";
import { router, tenantProcedure } from "../trpc";
import { readSetting } from "./config-store";
import { regionalSetting } from "./regional";

export const organizationsRouter = router({
  /**
   * The caller's currency (B-18) and time zone and language (NF-33). RLS makes the
   * settings row the only one visible; time zone and language come from the
   * configuration store and are changed with `config.set` (K-10).
   */
  settings: tenantProcedure.query(async ({ ctx }) => {
    const [settings] = await ctx.tx.select().from(organizationSettings);
    if (!settings) throw new TRPCError({ code: "NOT_FOUND" });
    const regional = await readSetting(ctx.tx, regionalSetting);
    return { organizationId: settings.organizationId, currency: settings.currency, ...regional.value, regionalVersion: regional.version };
  }),
});
