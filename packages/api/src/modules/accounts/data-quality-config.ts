import { dataQualityConfigSchema, dataQualityRuleSettingsSchema, effectiveDataQualityRules, type DataQualityConfig, type EffectiveDataQualityRule } from "@flowless/shared-types";

/*
 * The `accounts.data_quality` setting (C-12, K-10): per rule whether it runs, how serious its
 * findings are, and whether the sweep raises one exception per finding (X-02). A rule not
 * mentioned keeps the catalogue default (on, the catalogue severity, no exceptions), and
 * every field is optional, so a version stored today still reads when a field or a rule is
 * added later. Keys are not limited to the catalogue's: a retired rule in an old version is
 * ignored rather than failing the read. The schema is shared with the web form
 * (`@flowless/shared-types`); the module keeps exporting it.
 */
export { dataQualityConfigSchema, dataQualityRuleSettingsSchema, type DataQualityConfig };

/** The catalogue with this organization's settings applied. */
export const effectiveRules = (config: DataQualityConfig): EffectiveDataQualityRule[] => effectiveDataQualityRules(config.rules);
