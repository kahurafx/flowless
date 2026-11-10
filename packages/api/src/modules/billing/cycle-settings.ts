import { CYCLE_FREQUENCIES, CYCLE_TRIGGERS } from "@flowless/db/schema/billing";
import { z } from "zod";
import { defineSetting } from "../../kernel/config-store";

/** Minor units as digits: settings are JSON, money never a float. */
const minor = z.string().regex(/^\d{1,15}$/, "minor units as digits");

/**
 * B-01: when a bill is made and how often a route is billed. `batch` bills the cycle's
 * accounts together when the calculation state starts; `on_reading` bills an account as its
 * reading clears (the jobs are P5-4; the cycle records the choice it was opened with).
 */
export const billingCycleSchema = z.object({
  trigger: z.enum(CYCLE_TRIGGERS).default("batch"),
  frequency: z.enum(CYCLE_FREQUENCIES).default("monthly"),
});
export type BillingCycleSettings = z.infer<typeof billingCycleSchema>;

export const billingCycleSetting = defineSetting<BillingCycleSettings>({
  key: "billing.cycle",
  module: "billing",
  label: "Billing cycle",
  description: "When bills are made (on each reading or in a batch) and how often a route is billed.",
  schema: billingCycleSchema,
  default: { trigger: "batch", frequency: "monthly" },
});

/**
 * B-16: review by exception. A clean bill (not flagged) at or under `bulkApproveBelow` may be
 * approved in bulk, except a random sample (`sampleRate` of them, at least `sampleMinimum`)
 * a person spot-checks. A bill over `individualAbove` is decided only by a member who may
 * approve (`billing:approve`). Amounts are minor units.
 */
export const billingReviewSchema = z
  .object({
    bulkApproveBelow: minor.default("1000000"),
    individualAbove: minor.default("5000000"),
    sampleRate: z.number().min(0).max(1).default(0.05),
    sampleMinimum: z.number().int().min(0).max(1000).default(3),
  })
  .refine((v) => BigInt(v.individualAbove) >= BigInt(v.bulkApproveBelow), { message: "The individual-approval threshold cannot be below the bulk threshold" });
export type BillingReview = z.infer<typeof billingReviewSchema>;

export const billingReviewSetting = defineSetting<BillingReview>({
  key: "billing.review",
  module: "billing",
  label: "Bill review",
  description: "Which bills may be approved in bulk, how many are spot-checked, and the amount above which only an approver decides.",
  schema: billingReviewSchema,
  default: { bulkApproveBelow: "1000000", individualAbove: "5000000", sampleRate: 0.05, sampleMinimum: 3 },
});
