import { ping } from "@flowless/db";
import { accessRouter } from "./kernel/access";
import { approvalsRouter } from "./kernel/approvals";
import { auditRouter } from "./kernel/audit";
import { configRouter } from "./kernel/config";
import { entitlementsRouter } from "./kernel/entitlements";
import { exceptionsRouter } from "./kernel/exceptions";
import { filesRouter } from "./kernel/files";
import { notificationsRouter } from "./kernel/notifications";
import { supportRouter } from "./kernel/support";
import { hierarchyRouter } from "./kernel/hierarchy";
import { organizationsRouter } from "./kernel/organizations";
import { accountsRouter } from "./modules/accounts";
import { createGisRouter } from "./modules/gis";
import { tariffsRouter } from "./modules/tariffs";
import { createWorkOrdersRouter } from "./modules/work-orders";
import { createCallerFactory, publicProcedure, router } from "./trpc";
import { work } from "./wiring";

/** One key per kernel area or module (docs/build-plan.md, Code layout). */
export const appRouter = router({
  health: publicProcedure.query(async ({ ctx }) => {
    await ping(ctx.db);
    return { status: "ok" as const };
  }),
  organization: organizationsRouter,
  config: configRouter,
  access: accessRouter,
  hierarchy: hierarchyRouter,
  entitlements: entitlementsRouter,
  audit: auditRouter,
  exceptions: exceptionsRouter,
  approvals: approvalsRouter,
  files: filesRouter,
  notifications: notificationsRouter,
  support: supportRouter,
  // Modules, at the camelCase of their module key (module-matrix.test.ts).
  workOrders: createWorkOrdersRouter(work),
  gis: createGisRouter(work),
  accounts: accountsRouter,
  tariffs: tariffsRouter,
});

export type AppRouter = typeof appRouter;

/** In-process caller for server code and tests. */
export const createCaller = createCallerFactory(appRouter);
