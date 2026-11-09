import { router } from "../../trpc";
import { accountProcedureSet } from "./accounts";
import { contactsRouter, customersRouter } from "./customers";
import { lifecycleProcedureSet } from "./lifecycle-router";
import { accountsProcedures } from "./procedures";
import { servicePointsRouter } from "./service-points";

/**
 * The Accounts router (C-01, C-02, glossary), mounted at `accounts`: `customers.*`,
 * `contacts.*`, `servicePoints.*`, and the account procedures at its root (`accounts.create`,
 * `get`, `list`, `search`, `nextNumberPreview`), plus the account lifecycle (C-03, C-04,
 * C-06, C-11, `lifecycle-router.ts`): the status commands, `commands.list`, `statusRules`,
 * `activation.*` and `requestWriteOff`. Applications, memberships and succession are F3b.
 */
const lifecycleRouters = lifecycleProcedureSet(accountsProcedures);

export const accountsRouter = router({
  ...accountProcedureSet(accountsProcedures),
  ...lifecycleRouters,
  customers: customersRouter(accountsProcedures),
  contacts: contactsRouter(accountsProcedures),
  servicePoints: servicePointsRouter(accountsProcedures),
});
