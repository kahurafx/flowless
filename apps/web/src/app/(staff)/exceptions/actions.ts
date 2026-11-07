"use server";

import { clientErrorMessage } from "@flowless/api";
import { refresh } from "next/cache";
import { getApi } from "@/data/session";

type Api = Awaited<ReturnType<typeof getApi>>["api"];

/** One queue action as the signed-in member; the procedures check `exceptions:resolve` and scope. */
async function run(change: (api: Api) => Promise<unknown>): Promise<{ error: string | null }> {
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

export const assignException = async (id: string, ownerUserId: string | null) =>
  run((api) => api.exceptions.assign({ id, ownerUserId }));
export const startException = async (id: string) => run((api) => api.exceptions.start({ id }));
export const retryException = async (id: string) => run((api) => api.exceptions.retry({ id }));
export const resolveException = async (id: string, note: string) => run((api) => api.exceptions.resolve({ id, note }));
