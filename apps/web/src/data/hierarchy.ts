import type { Area, Route } from "@flowless/shared-types";
import { cache } from "react";
import { getApi, getSession } from "./session";

/** Areas and routes of the organization (K-02), archived ones included and marked. */
export const getHierarchy = cache(async (): Promise<{ areas: Area[]; routes: Route[]; canManage: boolean }> => {
  const [{ api }, { access }] = await Promise.all([getApi(), getSession()]);
  const [areas, routes] = await Promise.all([
    api.hierarchy.areas({ includeArchived: true }),
    api.hierarchy.routes({ includeArchived: true }),
  ]);
  return { areas, routes, canManage: access.permissions.includes("settings:manage") };
});
