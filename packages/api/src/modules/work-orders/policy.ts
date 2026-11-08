import { REVIEW_POLICIES, type ReviewPolicy } from "@flowless/shared-types";
import { z } from "zod";
import { defineSetting } from "../../kernel/config-store";
import type { WorkKindDef } from "../../kernel/work";

/**
 * Per-kind overrides an organization sets in the configuration store (K-10, NF-32): the
 * review policy and the hours a job has before it is overdue (SLA). Kinds not listed keep
 * the defaults they were registered with. A Work Orders setting: hidden, and so not
 * settable, while only GIS is licensed (level basic keeps the kinds' defaults).
 */
export const kindPolicySetting = defineSetting({
  key: "work-orders.kind_policy",
  module: "work-orders",
  label: "Job kinds: review and SLA",
  description:
    "For each kind of job (by key), whether finishing it needs a reviewer's approval (none, optional, required) and how many hours a new job has before it is overdue.",
  schema: z.record(
    z.string(),
    z.object({
      review: z.enum(REVIEW_POLICIES).optional(),
      slaHours: z.number().int().positive().max(8760).optional(),
    }),
  ),
  default: {},
});

export type KindPolicies = z.infer<typeof kindPolicySetting.schema>;

export interface EffectivePolicy {
  review: ReviewPolicy;
  slaHours: number | null;
}

export function effectivePolicy(kind: WorkKindDef, policies: KindPolicies): EffectivePolicy {
  const own = policies[kind.key];
  return { review: own?.review ?? kind.review, slaHours: own?.slaHours ?? kind.slaHours ?? null };
}
