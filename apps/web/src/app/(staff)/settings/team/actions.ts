"use server";

import { clientErrorMessage } from "@flowless/api";
import type { Permission } from "@flowless/shared-types";
import { refresh } from "next/cache";
import { getApi } from "@/data/session";

/**
 * Grants or revokes one extra permission (K-03). The procedure enforces `access:manage`
 * and that the caller holds what they grant; this only reports its message.
 */
export async function setPermission(userId: string, permission: Permission, granted: boolean) {
  const { api } = await getApi();
  try {
    await (granted ? api.access.grant({ userId, permission }) : api.access.revoke({ userId, permission }));
  } catch (error) {
    const message = clientErrorMessage(error);
    if (message) return { error: message };
    throw error;
  }
  refresh();
  return { error: null };
}

/** Replaces a member's scope restrictions (K-03). Empty lists mean the whole organization. */
export async function setScope(userId: string, areaIds: string[], routeIds: string[]) {
  const { api } = await getApi();
  try {
    await api.access.setScope({ userId, areaIds, routeIds });
  } catch (error) {
    const message = clientErrorMessage(error);
    if (message) return { error: message };
    throw error;
  }
  refresh();
  return { error: null };
}
