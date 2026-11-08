import { clientErrorMessage } from "@flowless/api";
import { refresh } from "next/cache";
import { getApi } from "./session";

export type Api = Awaited<ReturnType<typeof getApi>>["api"];
export type Result<T = null> = { error: string; data?: undefined } | { error: null; data: T };

/**
 * One change as the signed-in member, for server actions. The procedures check licence,
 * permission, scope and branch rules; a refusal comes back as `error`, anything else throws.
 * `refresh()` re-renders the page's server data unless the caller asks not to.
 */
export async function runAction<T>(change: (api: Api) => Promise<T>, options: { refresh?: boolean } = {}): Promise<Result<T>> {
  const { api } = await getApi();
  let data: T;
  try {
    data = await change(api);
  } catch (error) {
    const message = clientErrorMessage(error);
    if (message) return { error: message };
    throw error;
  }
  if (options.refresh !== false) refresh();
  return { error: null, data };
}
