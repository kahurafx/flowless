"use server";

import { runAction } from "@/data/run-action";
import { optionalText } from "@/lib/optional-text";

/** Decide a pending request (K-05). The kernel refuses a decision the member may not make, including on their own request. */
export const approveAction = async (id: string, note: string) =>
  runAction((api) => api.approvals.approve({ id, ...optionalText("note", note) }).then(() => null));

export const rejectAction = async (id: string, note: string) => runAction((api) => api.approvals.reject({ id, note }).then(() => null));

export const withdrawAction = async (id: string) => runAction((api) => api.approvals.cancel({ id }).then(() => null));
