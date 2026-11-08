"use server";

import { runAction } from "@/data/run-action";

/** Post a branch to the live network, all or nothing. Needs `gis:post`; the procedure says why when it refuses. */
export async function postBranch(input: {
  branch: string;
  token: string;
  resolutions: Record<string, Record<string, "branch" | "main">>;
  override: boolean;
}) {
  return runAction((api) => api.gis.reconcile.post(input));
}

/** Abandon a branch. Its versions stay as history. */
export async function discardBranch(branch: string) {
  return runAction((api) => api.gis.reconcile.discard({ branch }));
}
