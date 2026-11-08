"use server";

import { clientErrorMessage } from "@flowless/api";
import { refresh } from "next/cache";
import { getApi } from "@/data/session";

async function run(change: (api: Awaited<ReturnType<typeof getApi>>["api"]) => Promise<unknown>) {
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

/** The procedures check `access:manage`. */
export async function grantSupport(input: { engineerEmail: string; reason: string; hours: number }) {
  return run((api) => api.support.grant(input));
}

export async function revokeSupport(id: string) {
  return run((api) => api.support.revoke({ id }));
}
