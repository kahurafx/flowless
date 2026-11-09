import { router } from "../../trpc";
import { accountProcedureSet } from "./accounts";
import { applicationsRouter } from "./application-router";
import { changesProcedureSet } from "./changes-router";
import { contactsRouter, customersRouter } from "./customers";
import { dataQualityRouter } from "./data-quality-router";
import { lifecycleProcedureSet } from "./lifecycle-router";
import { membershipsRouter } from "./memberships";
import { accountsProcedures } from "./procedures";
import { servicePointsRouter } from "./service-points";

/**
 * The Accounts router (C-01, C-02, glossary), mounted at `accounts`: `customers.*`,
 * `contacts.*`, `servicePoints.*`, and the account procedures at its root (`accounts.create`,
 * `get`, `list`, `search`, `nextNumberPreview`), plus the account lifecycle (C-03, C-04,
 * C-06, C-11, `lifecycle-router.ts`): the status commands, `commands.list`, `statusRules`,
 * `activation.*` and `requestWriteOff`; and the F3b workflows: `applications.*` (C-05),
 * `memberships.*` (C-07), `dataQuality.*` (C-12), `succeed` (C-08), `relocations.*` (C-09) and `changeName` with
 * `holders.*` (C-10).
 */
const lifecycleRouters = lifecycleProcedureSet(accountsProcedures);

export const accountsRouter = router({
  ...accountProcedureSet(accountsProcedures),
  ...lifecycleRouters,
  ...changesProcedureSet(accountsProcedures),
  applications: applicationsRouter(accountsProcedures),
  memberships: membershipsRouter(accountsProcedures),
  dataQuality: dataQualityRouter(accountsProcedures),
  customers: customersRouter(accountsProcedures),
  contacts: contactsRouter(accountsProcedures),
  servicePoints: servicePointsRouter(accountsProcedures),
});
