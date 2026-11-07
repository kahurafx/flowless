import { DEFAULT_ROLES, PERMISSION_STATEMENTS, type Permission, type RoleKey } from "@flowless/shared-types";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";

/**
 * Registers the Flowless default roles with Better Auth (K-03), so it accepts them on
 * members and invitations and governs its own endpoints with them. Only owners and admins
 * keep Better Auth's organization, member and invitation management.
 *
 * Better Auth checks role defaults only. Flowless checks, which also include a member's
 * extra grants (`kernel.member_permission`), run in `packages/api`.
 */
export const ac = createAccessControl({ ...defaultStatements, ...PERMISSION_STATEMENTS });

function toStatements(permissions: readonly Permission[]): Record<string, string[]> {
  const statements: Record<string, string[]> = {};
  for (const p of permissions) {
    const [resource, action] = p.split(":") as [string, string];
    (statements[resource] ??= []).push(action);
  }
  return statements;
}

const betterAuthBase = (role: RoleKey) =>
  role === "owner" ? ownerAc.statements : role === "admin" ? adminAc.statements : memberAc.statements;

// Flowless resources must not reuse Better Auth's names (organization, member, invitation,
// team, ac), or the spread below would drop Better Auth's own actions.
export const roles = Object.fromEntries(
  (Object.keys(DEFAULT_ROLES) as RoleKey[]).map((role) => [
    role,
    ac.newRole({ ...betterAuthBase(role), ...toStatements(DEFAULT_ROLES[role]) } as never),
  ]),
) as unknown as Record<RoleKey, ReturnType<typeof ac.newRole>>; // keeps role names typed for Better Auth
