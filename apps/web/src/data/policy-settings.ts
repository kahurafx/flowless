import { connection } from "next/server";
import { listPeople, nameOf } from "./people";
import { getApi, requireModule } from "./session";
import { BILLING_KEYS, METERING_KEYS, summarizePolicy } from "@/lib/policy-settings";

type Area = "billing" | "metering";

/**
 * The Billing or Metering configuration settings, each with the version in force, the newest
 * version (what a save is checked against), changes scheduled for later and the history (K-10).
 * Needs the module and `settings:manage`; the configuration procedures enforce the same.
 */
export async function getPolicySettings(area: Area) {
  const [session] = await Promise.all([requireModule(area, "settings:manage"), connection()]);
  const { api } = await getApi();
  const keys: readonly string[] = area === "billing" ? BILLING_KEYS : METERING_KEYS;
  const [list, histories, people, areas] = await Promise.all([
    api.config.list(),
    Promise.all(keys.map((key) => api.config.history({ key }))),
    listPeople(),
    area === "metering" ? api.hierarchy.areas({}) : Promise.resolve([]),
  ]);
  const timeZone = session.organization.settings.timeZone;
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
          version: found.version,
          latestVersion: found.latestVersion,
          isDefault: found.isDefault,
          scheduled: found.scheduled.map((s) => ({ version: s.version, effectiveFrom: s.effectiveFrom.toISOString(), summary: summarizePolicy(key, s.value) })),
          history: histories[i]!.map((v) => ({
            version: v.version,
            effectiveFrom: v.effectiveFrom.toISOString(),
            reason: v.reason,
            by: v.createdByUserId ? (nameOf(people, v.createdByUserId) ?? "A colleague") : "Flowless",
            inForce: v.version === found.version,
            scheduled: v.effectiveFrom.getTime() > now,
            summary: summarizePolicy(key, v.value),
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
    dmas: areas.filter((a) => a.level === "dma" && !a.archivedAt).map((a) => ({ value: a.id, label: a.name })),
  };
}
export type PolicySettings = Awaited<ReturnType<typeof getPolicySettings>>;
export type PolicySettingData = NonNullable<PolicySettings["settings"][string]>;
