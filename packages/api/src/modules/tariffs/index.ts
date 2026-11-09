/*
 * The Tariffs module's published interface (NF-30): what `root.ts` and the kernel registries
 * use, and what other modules may call. Accounts keeps `category_id` as an opaque uuid and
 * does not import this; modules that need to resolve it (Billing, the web through the API)
 * use the reads below, always with a transaction scoped to the organization.
 */
export { tariffsRouter } from "./router";
export { tariffPolicySetting, type TariffPolicy } from "./settings";
export {
  chargeItemAmountChanged,
  chargeItemCreated,
  invoiceTypeChanged,
  seedDefaultsOnCreation,
  seedDefaultsOnLicence,
  tariffVersionCreated,
} from "./events";
export { ensureDefaults, DEFAULT_CHARGE_ITEMS, DEFAULT_INVOICE_TYPES } from "./defaults";

// Reads for Accounts' category ids, Billing's pricing and the invoice number counter.
export {
  allocateInvoiceNumber,
  categoriesById,
  categoryExists,
  categoryPricing,
  chargeItemByCode,
  tariffVersionInForce,
} from "./service";

// The closed-period port (T-03): Billing registers the source of "closed through" in Phase 4.
export { closedThrough, registerClosedPeriodSource, type ClosedPeriodSource } from "./closed-period";

// Pure rules shared with Billing and the clients.
export {
  bandProblems,
  bandsFor,
  chargeForUnits,
  fromLineRows,
  tariffContentSchema,
  toLineRows,
  validateTariffContent,
  type Band,
  type TariffContent,
} from "./content";
export { nextPeriodStart, planEffectiveDate, versionInForce, versionSpans } from "./dating";
export { installmentAmounts, minimumDeposit, formatInvoiceNumber } from "./invoice-policy";
export { lateFee, lateFeeRuleSchema, type LateFeeResult, type LateFeeRule } from "./late-fee";
