import { isPermission, parseRoles, type Permission, type RoleKey } from "@flowless/shared-types";
import { getAuth } from "@/server/auth";
import { getApi, requirePermission } from "./session";

export interface TeamMember {
  userId: string;
  name: string;
  /** Email for owners and admins; the username for staff (requirements §1). */
  signIn: string;
  roles: RoleKey[];
  /** Extra permissions on top of the role's defaults (K-03). */
  grants: Permission[];
}

/** Staff without email hold a reserved `<username>@<code>.staff.invalid` address. */
function signInName(email: string): string {
  return email.endsWith(".staff.invalid") ? email.slice(0, email.indexOf("@")) : email;
}

/** Members of the organization and their extra permissions. Needs `access:manage`. */
export async function listTeam(): Promise<{ members: TeamMember[]; myPermissions: readonly Permission[] }> {
  const { access, organization } = await requirePermission("access:manage");
  const { headers, api } = await getApi();
  const [{ members }, grants] = await Promise.all([
    getAuth().api.listMembers({ headers, query: { organizationId: organization.id, limit: 500 } }),
    api.access.grants(),
  ]);
  return {
    myPermissions: access.permissions,
    members: members
      .map((m) => ({
        userId: m.userId,
        name: m.user.name,
        signIn: signInName(m.user.email),
        roles: parseRoles(m.role),
        grants: grants.filter((g) => g.userId === m.userId).map((g) => g.permission).filter(isPermission),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
