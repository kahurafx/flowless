import { DATA_QUALITY_SEVERITIES, effectiveDataQualityRules, type EffectiveDataQualityRule } from "@flowless/shared-types";
import { z } from "zod";

/*
 * The `accounts.data_quality` setting (C-12, K-10): per rule whether it runs, how serious its
 * findings are, and whether the sweep raises one exception per finding (X-02). A rule not
 * mentioned keeps the catalogue default (on, the catalogue severity, no exceptions), and
 * every field is optional, so a version stored today still reads when a field or a rule is
 * added later. Keys are not limited to the catalogue's: a retired rule in an old version is
 * ignored rather than failing the read.
 */
export const dataQualityRuleSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  severity: z.enum(DATA_QUALITY_SEVERITIES).optional(),
  raiseExceptions: z.boolean().optional(),
});

export const dataQualityConfigSchema = z.object({
  rules: z.record(z.string(), dataQualityRuleSettingsSchema).default({}),
});
export type DataQualityConfig = z.infer<typeof dataQualityConfigSchema>;

/** The catalogue with this organization's settings applied. */
export const effectiveRules = (config: DataQualityConfig): EffectiveDataQualityRule[] => effectiveDataQualityRules(config.rules);
