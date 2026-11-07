import { ping } from "@flowless/db";
import { accessRouter } from "./kernel/access";
import { auditRouter } from "./kernel/audit";
import { entitlementsRouter } from "./kernel/entitlements";
import { exceptionsRouter } from "./kernel/exceptions";
import { hierarchyRouter } from "./kernel/hierarchy";
import { organizationsRouter } from "./kernel/organizations";
import { createCallerFactory, publicProcedure, router } from "./trpc";

/** One key per kernel area or module (docs/build-plan.md, Code layout). */
export const appRouter = router({
  health: publicProcedure.query(async ({ ctx }) => {
    await ping(ctx.db);
    return { status: "ok" as const };
  }),
  organization: organizationsRouter,
  access: accessRouter,
  hierarchy: hierarchyRouter,
  entitlements: entitlementsRouter,
  audit: auditRouter,
  exceptions: exceptionsRouter,
});

export type AppRouter = typeof appRouter;

/** In-process caller for server code and tests. */
export const createCaller = createCallerFactory(appRouter);
