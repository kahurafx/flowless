import { z } from "zod";
import { defineSetting } from "../../kernel/config-store";

/**
 * How bills are priced and validated (T-05, B-05, B-08, NF-32). Versioned configuration,
 * read at the time of posting. The defaults are the reference implementation's
 * (`billing-engine.html`): tier bands stretched by the months a reading spans, an estimate
 * from the median of the last three usable spans, a ceiling of 300 units a month, no
 * estimate without history.
 */
export const billingPolicySchema = z.object({
  /** `by_period` stretches the monthly bands by the months a span covers; `none` is the legacy single month. */
  tierScaling: z.enum(["by_period", "none"]).default("by_period"),
  /** An estimate is the median of this many usable actual spans (units a month). */
  estimateAverageOf: z.number().int().min(1).max(12).default(3),
  /** Estimate units when there is no history; null holds the bill (NO_HISTORY). */
  estimateFallbackUnits: z.number().int().min(0).max(1_000_000).nullable().default(null),
  /** Above this many units a month the bill is held for approval (B-08). */
  outlierCeilingUnitsPerMonth: z.number().int().min(1).max(1_000_000).default(300),
  /** Dial digits, for rollover. */
  meterDigits: z.number().int().min(3).max(10).default(4),
  /** B-05: how an unread account is estimated. `none` never estimates; `noneAction` then decides. */
  estimateMethod: z.enum(["median", "trimmed_mean", "same_month_last_year", "last_actual", "fixed_minimum", "none"]).default("median"),
  /** Fraction dropped from each end by `trimmed_mean`. */
  estimateTrim: z.number().min(0).max(0.49).default(0.2),
  /** Units a month for `fixed_minimum` (null: the baseline fallback applies). */
  estimateFixedMinimum: z.number().int().min(0).max(1_000_000).nullable().default(null),
  /** Under `none`: hold the bill, bill the standing charge only, or skip the period; the account is always flagged. */
  noneAction: z.enum(["hold", "standing_only", "skip"]).default("hold"),
  /** B-08: flag (not hold) a bill above this multiple of the account's usual use; 0 turns it off. */
  outlierFactor: z.number().min(0).max(100).default(3),
  /** The invoice type (Tariffs code) that billing runs post usage bills under. */
  usageInvoiceTypeCode: z.string().trim().min(1).max(40).default("usage"),
});
export type BillingPolicy = z.infer<typeof billingPolicySchema>;

export const billingPolicySetting = defineSetting({
  key: "billing.policy",
  module: "billing",
  label: "Billing policy",
  description: "Tier scaling, estimates and the outlier ceiling used when a bill is priced.",
  schema: billingPolicySchema,
  default: { tierScaling: "by_period", estimateAverageOf: 3, estimateFallbackUnits: null, outlierCeilingUnitsPerMonth: 300, meterDigits: 4, estimateMethod: "median", estimateTrim: 0.2, estimateFixedMinimum: null, noneAction: "hold", outlierFactor: 3, usageInvoiceTypeCode: "usage" },
});
