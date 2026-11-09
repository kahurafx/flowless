/*
 * The Accounts module's published interface (NF-30): what `root.ts` and the kernel
 * registries use. Other modules learn about customers, accounts and service points through
 * the events below; Tariffs resolves an account's opaque `category_id` through its own
 * interface, and Accounts never reads another module's tables.
 */
export { accountsRouter } from "./router";
export { numberingSetting } from "./settings";
export { accountOpened, customerCreated, servicePointCreated } from "./events";
export {
  checkDigitOf,
  childAccountNumber,
  formatAccountNumber,
  hasValidCheckDigit,
  isValidAccountNumber,
  numberingFormatSchema,
  parseAccountNumber,
  type NumberingFormat,
} from "./numbering";
