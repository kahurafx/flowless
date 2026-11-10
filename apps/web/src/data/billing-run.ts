import { billingErrorMessage } from "@/lib/billing-view";
import { runAction, type Api } from "./run-action";

/** `runAction` for Billing and Metering changes: a refusal is reworded by its code (CONFLICT, NOT_FOUND, PRECONDITION_FAILED) before it reaches the dialog. */
export function billingAction<T>(change: (api: Api) => Promise<T>, options: { refresh?: boolean } = {}) {
  return runAction(async (api) => {
    try {
      return await change(api);
    } catch (error) {
      if (error instanceof Error && "code" in error && typeof error.code === "string") error.message = billingErrorMessage(error.code, error.message);
      throw error;
    }
  }, options);
}
