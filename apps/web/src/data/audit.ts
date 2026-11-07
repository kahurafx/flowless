import { getAuth } from "@/server/auth";
import { getHierarchy } from "./hierarchy";
import { getApi, requirePermission } from "./session";

/**
 * One page of the audit log (K-06), newest first, with names for the members, areas and
 * routes it mentions. Needs `audit:read`.
 */
export async function listAudit(options: { actionPrefix?: string; before?: bigint }) {
  const { organization } = await requirePermission("audit:read");
  const { api, headers } = await getApi();
  const [page, chain, { members }, { areas, routes }] = await Promise.all([
    api.audit.list({ actionPrefix: options.actionPrefix, before: options.before, limit: 50 }),
    api.audit.verify(),
    getAuth().api.listMembers({ headers, query: { organizationId: organization.id, limit: 500 } }),
    getHierarchy(),
  ]);
  const names = new Map<string, string>([
    ...members.map((m) => [m.userId, m.user.name] as const),
    ...areas.map((a) => [a.id, a.name] as const),
    ...routes.map((r) => [r.id, `${r.code} · ${r.name}`] as const),
  ]);
  return { ...page, chain, names };
}
