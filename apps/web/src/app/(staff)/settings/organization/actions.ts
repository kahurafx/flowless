"use server";

import { clientErrorMessage } from "@flowless/api";
import { refresh } from "next/cache";
import { getApi } from "@/data/session";

/** Saves time zone and language as a new version (K-10); the procedure checks `settings:manage`. */
export async function saveRegional(input: { timeZone: string; locale: string; expectedVersion: number; reason: string }) {
  const { api } = await getApi();
  try {
    await api.config.set({
      key: "kernel.regional",
      value: { timeZone: input.timeZone, locale: input.locale },
      expectedVersion: input.expectedVersion,
      reason: input.reason || undefined,
    });
  } catch (error) {
    const message = clientErrorMessage(error);
    if (message) return { error: message };
    throw error;
  }
  refresh();
  return { error: null };
}
