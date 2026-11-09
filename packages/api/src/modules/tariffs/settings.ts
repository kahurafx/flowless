import { z } from "zod";
import { defineSetting } from "../../kernel/config-store";

/**
 * Tariff change policy (T-03, NF-32). Billing periods are calendar months (requirements
 * section 1); `periodStartDay` is the day each one starts on. A tariff, category or charge
 * amount change takes effect at the next period start unless a date is given. The scaling
 * policy (`tier_scaling`, T-05) and the reading-date rule are Billing's, not here.
 */
export const tariffPolicySchema = z.object({
  periodStartDay: z.number().int().min(1).max(28).default(1),
});
export type TariffPolicy = z.infer<typeof tariffPolicySchema>;

export const tariffPolicySetting = defineSetting({
  key: "tariffs.policy",
  module: "tariffs",
  label: "Tariff changes",
  description: "The day of the month a billing period starts on. A tariff, category or charge amount change takes effect at the next period start unless it is dated.",
  schema: tariffPolicySchema,
  default: { periodStartDay: 1 },
});
