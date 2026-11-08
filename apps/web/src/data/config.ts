import { getAuth } from "@/server/auth";
import { getApi, getSession } from "./session";

const REGIONAL = "kernel.regional";

/**
 * Time zone and language (NF-33) with their history, from the configuration store
 * (K-10). Members without `settings:manage` see only the values in force.
 */
export async function getRegional() {
  const session = await getSession();
  const { timeZone, locale, regionalVersion } = session.organization.settings;
  const canManage = session.access.permissions.includes("settings:manage");
  if (!canManage) return { timeZone, locale, version: regionalVersion, latestVersion: regionalVersion, canManage, history: [] };

  const { api, headers } = await getApi();
  const [list, history, { members }] = await Promise.all([
    api.config.list(),
    api.config.history({ key: REGIONAL }),
    getAuth().api.listMembers({ headers, query: { organizationId: session.organization.id, limit: 500 } }),
  ]);
  const names = new Map(members.map((m) => [m.userId, m.user.name]));
  const setting = list.find((s) => s.key === REGIONAL);
  return {
    timeZone,
    locale,
    version: regionalVersion,
    latestVersion: setting?.latestVersion ?? regionalVersion,
    canManage,
    history: history.map((v) => ({
      version: v.version,
      value: v.value as { timeZone: string; locale: string },
      effectiveFrom: v.effectiveFrom,
      reason: v.reason,
      by: v.createdByUserId ? (names.get(v.createdByUserId) ?? "Former member") : "Flowless",
    })),
  };
}
