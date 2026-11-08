import { connection } from "next/server";
import { getAuth } from "@/server/auth";
import { getApi, requirePermission } from "./session";

/** Support access grants (K-12), newest first, with who granted and revoked them. Needs `access:manage`. */
export async function listSupportGrants() {
  // Grant status depends on the clock.
  const [{ organization }] = await Promise.all([requirePermission("access:manage"), connection()]);
  const { api, headers } = await getApi();
  const [grants, { members }] = await Promise.all([
    api.support.list(),
    getAuth().api.listMembers({ headers, query: { organizationId: organization.id, limit: 500 } }),
  ]);
  const names = new Map(members.map((m) => [m.userId, m.user.name]));
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? "Former member") : null);
  return {
    locale: organization.settings.locale,
    timeZone: organization.settings.timeZone,
    grants: grants.map((g) => ({ ...g, grantedBy: nameOf(g.grantedByUserId), revokedBy: nameOf(g.revokedByUserId) })),
  };
}

export type SupportGrantRow = Awaited<ReturnType<typeof listSupportGrants>>["grants"][number];
