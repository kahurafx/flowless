import type { WorkRegistry } from "../../kernel/work";
import { router } from "../../trpc";
import { contentProcedures } from "./contents";
import { crewsRouter } from "./crews";
import { lifecycleProcedures } from "./lifecycle";
import { workOrderProcedures } from "./procedures";
import { readProcedures } from "./reads";

/**
 * The Work Orders router (W-01 to W-03), ported from Majimap. Built over a work registry so
 * tests can bring their own kinds and resolvers; `root.ts` passes the wired one.
 */
export function createWorkOrdersRouter(work: WorkRegistry) {
  const p = workOrderProcedures(work);
  return router({
    ...readProcedures(p),
    ...lifecycleProcedures(p),
    ...contentProcedures(p),
    crews: crewsRouter(p),
  });
}
