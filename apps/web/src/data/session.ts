import { createCaller } from "@flowless/api";
import type { Permission } from "@flowless/shared-types";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { profileFor } from "@/mocks/tenants";
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
 * sign-in. Identity, membership and permissions are real; the organization's settings
 * and entitlements are still mock profiles until A4/A8.
 */
export const getSession = cache(async () => {
  const { caller, headers: requestHeaders, api } = await getApi();
  const [organization, access] = await Promise.all([
    getAuth().api.getFullOrganization({
      headers: requestHeaders,
      query: { organizationId: caller.session.activeOrganizationId!, membersLimit: 0 },
    }),
    api.access.me(),
  ]);
  if (!organization) redirect("/sign-in");

  return {
    user: { id: caller.user.id, name: caller.user.name, email: caller.user.email },
    access,
    organization: {
      id: organization.id,
      name: organization.name,
      code: organization.slug,
      ...profileFor(organization.slug),
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
