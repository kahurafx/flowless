import type { Consumer } from "./events";
import { createOrganizationSettings } from "./organization-events";

/**
 * Every event consumer, kernel and modules (K-09). `apps/worker` runs these. A module adds
 * its consumers from its `registerKernel` (called in `src/wiring.ts`) with `registerConsumer`;
 * an unlicensed module's are skipped. Live: read it only after wiring (import it from
 * `wiring.ts` or the package index).
 */
export const consumers: readonly Consumer[] = [createOrganizationSettings as Consumer];

const list = consumers as Consumer[];
const names = new Set<string>(list.map((c) => c.name));

export function registerConsumer<T>(consumer: Consumer<T>): void {
  if (names.has(consumer.name)) throw new Error(`Consumer "${consumer.name}" is registered twice`);
  names.add(consumer.name);
  list.push(consumer as Consumer);
}
