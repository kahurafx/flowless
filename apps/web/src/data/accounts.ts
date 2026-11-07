import {
  buildStatement,
  money,
  sumMoney,
  type AccountSummary,
  type StatementRow,
} from "@flowless/shared-types";
import { accounts, ledger, type MockAccount } from "@/mocks/accounts";
import { getSession } from "./session";

// UI track seam: becomes `caller.accounts.list()` / `caller.accounts.get()` in Phase 2.

function summarize(account: MockAccount, currency: string): AccountSummary {
  const { org: _org, openingMinor, ...rest } = account;
  // Balance is derived from the ledger, never stored (I-2).
  const lines = ledger[account.id] ?? [];
  const balance = sumMoney(currency, [money(openingMinor, currency), ...lines.map((l) => l.amount)]);
  return { ...rest, balance };
}

export async function listAccounts(): Promise<AccountSummary[]> {
  const { organization } = await getSession();
  return accounts
    .filter((a) => a.org === organization.code)
    .map((a) => summarize(a, organization.settings.currency));
}

export async function getAccount(
  number: string,
): Promise<{ account: AccountSummary; statement: StatementRow[]; opening: bigint } | null> {
  const { organization } = await getSession();
  const found = accounts.find((a) => a.org === organization.code && a.number === number);
  if (!found) return null;
  const { currency } = organization.settings;
  return {
    account: summarize(found, currency),
    statement: buildStatement(currency, found.openingMinor, ledger[found.id] ?? []),
    opening: found.openingMinor,
  };
}
