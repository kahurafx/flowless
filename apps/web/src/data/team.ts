import { isPermission, parseRoles, type Area, type Permission, type RoleKey, type Route } from "@flowless/shared-types";
import { getAuth } from "@/server/auth";
import { getHierarchy } from "./hierarchy";
import { getApi, requirePermission, type Session } from "./session";

export interface TeamMember {
  userId: string;
  name: string;
  /** Email for owners and admins; the username for staff (requirements §1). */
  signIn: string;
  roles: RoleKey[];
  /** Extra permissions on top of the role's defaults (K-03). */
  grants: Permission[];
  /** Areas and routes the member is limited to; both empty means the whole organization. */
  scope: { areaIds: string[]; routeIds: string[] };
}

export interface TeamData {
  members: TeamMember[];
  myPermissions: readonly Permission[];
  myScope: Session["access"]["scope"];
  areas: Area[];
  routes: Route[];
}

/** Staff without email hold a reserved `<username>@<code>.staff.invalid` address. */
function signInName(email: string): string {
  return email.endsWith(".staff.invalid") ? email.slice(0, email.indexOf("@")) : email;
}

/** Members of the organization and their extra permissions. Needs `access:manage`. */
export async function listTeam(): Promise<TeamData> {
  const { access, organization } = await requirePermission("access:manage");
  const { headers, api } = await getApi();
  const [{ members }, grants, scopes, hierarchy] = await Promise.all([
    getAuth().api.listMembers({ headers, query: { organizationId: organization.id, limit: 500 } }),
    api.access.grants(),
    api.access.scopes(),
    getHierarchy(),
  ]);
  return {
    myPermissions: access.permissions,
    myScope: access.scope,
    areas: hierarchy.areas.filter((a) => !a.archivedAt),
    routes: hierarchy.routes.filter((r) => !r.archivedAt),
    members: members
      .map((m) => ({
        userId: m.userId,
        name: m.user.name,
        signIn: signInName(m.user.email),
        roles: parseRoles(m.role),
        grants: grants.filter((g) => g.userId === m.userId).map((g) => g.permission).filter(isPermission),
        scope: scopes.find((sc) => sc.userId === m.userId) ?? { areaIds: [], routeIds: [] },
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
