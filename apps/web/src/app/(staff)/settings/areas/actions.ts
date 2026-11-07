"use server";

import { clientErrorMessage } from "@flowless/api";
import type { AreaLevel } from "@flowless/shared-types";
import { refresh } from "next/cache";
import { getApi } from "@/data/session";

type Result = { error: string | null };

/** Runs one hierarchy change as the signed-in member; the procedure checks `settings:manage`. */
async function run(change: (api: Awaited<ReturnType<typeof getApi>>["api"]) => Promise<unknown>): Promise<Result> {
  const { api } = await getApi();
  try {
    await change(api);
  } catch (error) {
    const message = clientErrorMessage(error);
    if (message) return { error: message };
    throw error;
  }
  refresh();
  return { error: null };
}

export async function createArea(input: { level: AreaLevel; code: string; name: string; parentId: string | null }) {
  return run((api) => api.hierarchy.createArea(input));
}

export async function createRoute(input: { code: string; name: string; parentId: string | null; areaId: string | null }) {
  return run((api) => api.hierarchy.createRoute(input));
}

export async function setArchived(kind: "area" | "route", id: string, archived: boolean) {
  return run((api) => {
    if (kind === "area") return archived ? api.hierarchy.archiveArea({ id }) : api.hierarchy.restoreArea({ id });
    return archived ? api.hierarchy.archiveRoute({ id }) : api.hierarchy.restoreRoute({ id });
  });
}
