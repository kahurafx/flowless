import { createContext, useContext, useMemo, useState } from "react";
import type { Resolutions, ReviewBranch } from "../lib/review";
import type { PostResult } from "../lib/types";

/**
 * The review area (G-03): branches waiting to be posted to the live network. Only members who may
 * post (`gis:post`) load them. Unlike field actions these go straight to the server, because they need
 * its answer (conflicts, integrity violations) and are not worth queueing.
 */
export type ReviewValue = {
  branches: ReviewBranch[];
  postBranch: (branch: string, resolutions: Resolutions, override?: boolean) => Promise<PostResult | { status: "failed"; message: string }>;
  discardBranch: (branch: string) => Promise<void>;
};

export const ReviewContext = createContext<ReviewValue | null>(null);
export function useReview(): ReviewValue {
  const v = useContext(ReviewContext);
  if (!v) throw new Error("useReview must be used inside <AppProvider>");
  return v;
}

export function useReviewState() {
  const [branches, setBranches] = useState<ReviewBranch[]>([]);
  return useMemo(() => ({ branches, setBranches }), [branches]);
}
