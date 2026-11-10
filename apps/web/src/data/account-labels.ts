import { orNull } from "./accounts";
import { getApi } from "./session";

export interface AccountLabel {
  id: string;
  number: string;
  customerName: string;
}

/**
 * Account numbers and customer names for ids that came from another module's rows (a cycle's
 * accounts, a case, a snapshot). There is no batch read, so each id is one `accounts.get`
 * (scope applies: an account outside the member's areas simply has no label). Needs `accounts:read`;
 * without Accounts the map is empty and callers show a short id.
 */
export async function accountLabels(ids: readonly string[]): Promise<Map<string, AccountLabel>> {
  const { api } = await getApi();
  const unique = [...new Set(ids)];
  const found = await Promise.all(
    unique.map(async (id) => {
      const account = await orNull(api.accounts.get({ id }));
      return account ? ([id, { id, number: account.number, customerName: account.customerName }] as const) : null;
    }),
  );
  return new Map(found.flatMap((f) => (f ? [f] : [])));
}

/** What to show for an account id: number and customer when known, else a short id. */
export const labelOf = (labels: ReadonlyMap<string, AccountLabel>, id: string): { text: string; number: string | null } => {
  const l = labels.get(id);
  return l ? { text: `${l.number} · ${l.customerName}`, number: l.number } : { text: id.slice(0, 8), number: null };
};
