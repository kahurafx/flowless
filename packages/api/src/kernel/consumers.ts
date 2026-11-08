import type { Consumer } from "./events";
import { seedAttachmentRulesOnLicence } from "../modules/gis";
import { createOrganizationSettings } from "./organization-events";

/**
 * Every event consumer, kernel and modules (K-09). `apps/worker` runs these. A module adds
 * its consumers here from its own `events.ts`; an unlicensed module's are skipped.
 */
export const consumers: readonly Consumer[] = [createOrganizationSettings as Consumer, seedAttachmentRulesOnLicence as Consumer];

const names = new Set<string>();
for (const c of consumers) {
  if (names.has(c.name)) throw new Error(`Consumer "${c.name}" is registered twice`);
  names.add(c.name);
}
