import { router } from "../../trpc";
import { accountProcedureSet } from "./accounts";
import { contactsRouter, customersRouter } from "./customers";
import { accountsProcedures } from "./procedures";
import { servicePointsRouter } from "./service-points";

/**
 * The Accounts router (C-01, C-02, glossary), mounted at `accounts`: `customers.*`,
 * `contacts.*`, `servicePoints.*`, and the account procedures at its root (`accounts.create`,
 * `get`, `list`, `search`, `nextNumberPreview`). Account lifecycle (C-03 to C-11) is Phase 3 F3.
 */
export const accountsRouter = router({
  ...accountProcedureSet(accountsProcedures),
  customers: customersRouter(accountsProcedures),
  contacts: contactsRouter(accountsProcedures),
  servicePoints: servicePointsRouter(accountsProcedures),
});
