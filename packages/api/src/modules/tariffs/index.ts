import type { KernelRegistrar } from "../../kernel/registrar";
import { seedDefaultsOnCreation as creationConsumer, seedDefaultsOnLicence as licenceConsumer } from "./events";
import { tariffPolicySetting as policy } from "./settings";

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
  chargeItemAmountInForce,
  chargeItemByCode,
  tariffVersionInForce,
} from "./service";

// The closed-period port (T-03): Billing registers the source of "closed through" in Phase 4.
export { closedThrough, registerClosedPeriodSource, type ClosedPeriodSource } from "./closed-period";

// Pure rules shared with Billing and the clients.
export { fromLineRows, toLineRows } from "./content";
export {
  bandProblems,
  bandsFor,
  chargeForUnits,
  formatInvoiceNumber,
  installmentAmounts,
  lateFee,
  lateFeeRuleSchema,
  minimumDeposit,
  nextPeriodStart,
  planEffectiveDate,
  tariffContentSchema,
  validateTariffContent,
  versionInForce,
  versionSpans,
  type Band,
  type LateFeeResult,
  type LateFeeRule,
  type TariffContent,
} from "@flowless/shared-types";

/** Adds Tariffs' setting and default-seeding consumers to the kernel's registries; called in `wiring.ts`. */
export function registerKernel(kernel: KernelRegistrar) {
  kernel.setting(policy);
  kernel.consumer(creationConsumer);
  kernel.consumer(licenceConsumer);
}
