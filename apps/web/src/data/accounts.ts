import {
  buildStatement,
  money,
  sumMoney,
  type AccountSummary,
  type StatementRow,
} from "@flowless/shared-types";
import { accounts, ledger, type MockAccount } from "@/mocks/accounts";
import { getHierarchy } from "./hierarchy";
import { requirePermission } from "./session";

// UI track seam: becomes `caller.accounts.list()` / `caller.accounts.get()` in Phase 3.

function summarize(account: MockAccount, currency: string): AccountSummary {
  const { org: _org, openingMinor, ...rest } = account;
  // Balance is derived from the ledger, never stored (I-2).
  const lines = ledger[account.id] ?? [];
  const balance = sumMoney(currency, [money(openingMinor, currency), ...lines.map((l) => l.amount)]);
  return { ...rest, balance };
}

/**
 * Scope restrictions (K-03) for the mocks, which carry a zone name and a route code. The
 * accounts procedure will filter by area and route ids instead (`scopeCovers`).
 */
async function inScope(): Promise<(account: MockAccount) => boolean> {
  const { scope } = (await requirePermission("accounts:read")).access;
  if (scope.kind === "all") return () => true;
  const { areas, routes } = await getHierarchy();
  const areaNames = new Set(areas.filter((a) => scope.areaIds.includes(a.id)).map((a) => a.name));
  const routeCodes = new Set(routes.filter((r) => scope.routeIds.includes(r.id)).map((r) => r.code));
  return (account) => areaNames.has(account.zone) || routeCodes.has(account.route);
}

export async function listAccounts(): Promise<AccountSummary[]> {
  const [{ organization }, visible] = await Promise.all([requirePermission("accounts:read"), inScope()]);
  return accounts
    .filter((a) => a.org === organization.code && visible(a))
    .map((a) => summarize(a, organization.settings.currency));
}

export async function getAccount(
  number: string,
): Promise<{ account: AccountSummary; statement: StatementRow[]; opening: bigint } | null> {
  const [{ organization }, visible] = await Promise.all([requirePermission("accounts:read"), inScope()]);
  const found = accounts.find((a) => a.org === organization.code && a.number === number && visible(a));
  if (!found) return null;
  const { currency } = organization.settings;
  return {
    account: summarize(found, currency),
    statement: buildStatement(currency, found.openingMinor, ledger[found.id] ?? []),
    opening: found.openingMinor,
  };
}
