import { createCaller } from "@flowless/api";
import type { ModuleKey, Permission } from "@flowless/shared-types";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { staffFor } from "@/mocks/tenants";
import { getAuth, getCaller } from "@/server/auth";
import { getDb } from "@/server/db";

/**
 * The signed-in caller for this request: Better Auth session plus current membership, and
 * an in-process tRPC caller acting as them. Redirects to sign-in when there is no
 * session or the user is no longer a member. Deduplicated per request.
 */
export const getApi = cache(async () => {
  const requestHeaders = await headers();
  const caller = await getCaller(requestHeaders);
  const organizationId = caller?.session.activeOrganizationId;
  if (!caller || !organizationId || caller.member?.organizationId !== organizationId) redirect("/sign-in");
  return { caller, headers: requestHeaders, api: createCaller({ db: getDb(), session: caller }) };
});

/**
 * The signed-in user, their organization, and what they may do (K-01, K-03). A user
 * belongs to exactly one organization, set as the session's active organization at
 * sign-in. Identity, membership, permissions, settings and licensed modules are real;
 * only the staff list for mock exceptions still comes from `src/mocks/tenants.ts`.
 */
export const getSession = cache(async () => {
  const { caller, headers: requestHeaders, api } = await getApi();
  const [organization, access, settings, entitlements] = await Promise.all([
    getAuth().api.getFullOrganization({
      headers: requestHeaders,
      query: { organizationId: caller.session.activeOrganizationId!, membersLimit: 0 },
    }),
    api.access.me(),
    api.organization.settings(),
    api.entitlements.list(),
  ]);
  if (!organization) redirect("/sign-in");

  return {
    user: { id: caller.user.id, name: caller.user.name, email: caller.user.email },
    access,
    organization: {
      id: organization.id,
      name: organization.name,
      code: organization.slug,
      settings: { currency: settings.currency, timeZone: settings.timeZone, locale: settings.locale },
      entitlements,
      staff: staffFor(organization.slug),
    },
  };
});

export type Session = Awaited<ReturnType<typeof getSession>>;

/**
 * The session, if the member holds `permission`; otherwise the page is not found, which
 * reveals nothing about what exists. Mock data functions call this so screens enforce
 * K-03 before their tRPC procedure (`permittedProcedure`) takes over.
 */
export async function requirePermission(permission: Permission): Promise<Session> {
  const session = await getSession();
  if (!session.access.permissions.includes(permission)) notFound();
  return session;
}

/**
 * The session, if the organization is licensed for `module` (K-04); otherwise the page is
 * not found, as an unlicensed module's procedures are (`moduleProcedure`).
 */
export async function requireModule(module: ModuleKey, permission?: Permission): Promise<Session> {
  const session = await getSession();
  if (!session.organization.entitlements.includes(module)) notFound();
  return permission ? requirePermission(permission) : session;
}
