import { WorkRegistry } from "./kernel/work";
import { register as registerAccounts } from "./modules/accounts";
import { register as registerGis } from "./modules/gis";
import { register as registerWorkOrders } from "./modules/work-orders";

/**
 * The composition root: where modules plug their adapters into the kernel's ports, so they
 * never import each other (NF-30). Each module exports a `register(work)` from its
 * `index.ts` and is called here when it ships (Work Orders in Phase 2 W2, GIS in W3).
 */
export const work = new WorkRegistry();
registerWorkOrders(work);
registerGis(work);
registerAccounts(work);
