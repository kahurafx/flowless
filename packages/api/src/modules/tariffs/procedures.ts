import { moduleProcedure } from "../../trpc";

/**
 * The Tariffs procedures (K-04, NF-03): the module's licence first, then the catalogue's
 * `tariffs:*` permissions (K-03).
 * - `read` (`tariffs:read`): categories, tariffs and their versions, the charge catalog,
 *   invoice types, previews and simulations.
 * - `manage` (`tariffs:manage`): every change. Each one is audited and publishes its event
 *   in the same transaction.
 */
export const tariffsProcedures = {
  read: moduleProcedure("tariffs", "tariffs:read"),
  manage: moduleProcedure("tariffs", "tariffs:read", "tariffs:manage"),
};

export type TariffsProcedures = typeof tariffsProcedures;
