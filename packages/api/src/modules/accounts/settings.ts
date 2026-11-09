import { defineSetting } from "../../kernel/config-store";
import { DEFAULT_NUMBERING, numberingFormatSchema } from "./numbering";

/**
 * How this organization numbers accounts (C-02, NF-32): prefix, digits, check-digit scheme,
 * separator and the child-letter style. Behaviour is configuration, never per-tenant code.
 * A change applies to numbers issued from then on; issued numbers are never rewritten, and
 * the sequence counter only moves forward (raising `start` skips ahead).
 */
export const numberingSetting = defineSetting({
  key: "accounts.numbering",
  module: "accounts",
  label: "Account numbers",
  description:
    "The format of new account numbers: an optional prefix, the sequence padded to a width, a check digit (none, luhn or mod11) and a separator. Child accounts add letters to their parent's number.",
  schema: numberingFormatSchema,
  default: DEFAULT_NUMBERING,
});
