import { router } from "../../trpc";
import { categoriesRouter } from "./categories";
import { chargeItemsRouter } from "./charge-items";
import { invoiceTypesRouter, simulateLateFee } from "./invoice-types";
import { tariffsProcedures } from "./procedures";
import { tariffProcedureSet } from "./tariffs";

/**
 * The Tariffs router (T-01 to T-03, T-07 to T-10), mounted at `tariffs`: the tariff
 * procedures at its root (`tariffs.list`, `create`, `addVersion`, `versions`, `inForce`,
 * `nextEffectiveDate`), `simulateLateFee`, and `categories.*`, `chargeItems.*`,
 * `invoiceTypes.*`. Invoicing, tariff simulation (T-06) and pricing (T-04, T-05) are Billing's.
 */
export const tariffsRouter = router({
  ...tariffProcedureSet(tariffsProcedures),
  simulateLateFee: simulateLateFee(tariffsProcedures),
  categories: router(categoriesRouter(tariffsProcedures)),
  chargeItems: router(chargeItemsRouter(tariffsProcedures)),
  invoiceTypes: router(invoiceTypesRouter(tariffsProcedures)),
});
