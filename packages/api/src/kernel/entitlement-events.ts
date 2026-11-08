import { MODULE_KEYS } from "@flowless/shared-types";
import { z } from "zod";
import { ENTITLEMENTS_CHANGED } from "./entitlement-store";
import { defineEvent } from "./events";

/**
 * An organization's licensed modules changed (K-04), published by `setEntitlements` in the
 * same transaction. A module's consumer sets the module up for a new licence, idempotently
 * (GIS seeds the organization's structure-attachment rules).
 */
export const entitlementsChanged = defineEvent(
  ENTITLEMENTS_CHANGED,
  z.object({ before: z.array(z.enum(MODULE_KEYS)), after: z.array(z.enum(MODULE_KEYS)) }),
);
