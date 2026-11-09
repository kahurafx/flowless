import { connection } from "next/server";
import { listPeople, nameOf } from "./people";
import { getApi, requireModule } from "./session";
import { SETTING_KEYS, summarize } from "@/lib/account-settings";

/**
 * The Accounts configuration settings and the two Accounts approval policies, each with its
 * version in force, the newest version (what a save is checked against), changes scheduled
 * for later and the history (K-10). Needs `settings:manage` and the Accounts module; the
 * configuration procedures enforce the same.
 */
export async function getAccountsSettings() {
  const [session] = await Promise.all([requireModule("accounts", "settings:manage"), connection()]);
  const { api } = await getApi();
  const timeZone = session.organization.settings.timeZone;
  const keys = Object.values(SETTING_KEYS);
  const tariffsOn = session.organization.entitlements.includes("tariffs") && session.access.permissions.includes("tariffs:read");

  const [list, histories, people, preview, items] = await Promise.all([
    api.config.list(),
    Promise.all(keys.map((key) => api.config.history({ key }))),
    listPeople(),
    api.accounts.nextNumberPreview(),
    tariffsOn ? api.tariffs.chargeItems.list({ active: true }) : Promise.resolve(null),
  ]);

  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const now = Date.now();
  const settings = Object.fromEntries(
    keys.map((key, i) => {
      const found = list.find((s) => s.key === key);
      if (!found) return [key, null] as const;
      return [
        key,
        {
          key,
          label: found.label,
          value: found.value as unknown,
          /** The version in force now (0 is the built-in default). */
          version: found.version,
          latestVersion: found.latestVersion,
          isDefault: found.isDefault,
          scheduled: found.scheduled.map((s) => ({ version: s.version, effectiveFrom: s.effectiveFrom.toISOString(), summary: summarize(key, s.value) })),
          history: histories[i]!.map((v) => ({
            version: v.version,
            effectiveFrom: v.effectiveFrom.toISOString(),
            reason: v.reason,
            by: v.createdByUserId ? (nameOf(people, v.createdByUserId) ?? "A colleague") : "Flowless",
            inForce: v.version === found.version,
            scheduled: v.effectiveFrom.getTime() > now,
            summary: summarize(key, v.value),
          })),
        },
      ] as const;
    }),
  );

  return {
    settings,
    today,
    currency: session.organization.settings.currency,
    locale: session.organization.settings.locale,
    timeZone,
    /** What the next account number would be under the format in force. */
    nextNumber: preview.next,
    chargeItems: items ? items.map((i) => ({ code: i.code, name: i.name, type: i.type })) : null,
  };
}

export type AccountsSettings = Awaited<ReturnType<typeof getAccountsSettings>>;
export type SettingData = NonNullable<AccountsSettings["settings"][string]>;
