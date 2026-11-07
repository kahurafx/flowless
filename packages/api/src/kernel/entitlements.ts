import { router, tenantProcedure } from "../trpc";

export const entitlementsRouter = router({
  /** What this organization is licensed for; navigation and screens are built from it (K-04). */
  list: tenantProcedure.query(({ ctx }) => ctx.entitlements()),
});
