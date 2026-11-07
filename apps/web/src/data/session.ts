import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { profileFor } from "@/mocks/tenants";
import { getAuth } from "@/server/auth";

/**
 * The signed-in user and their organization (K-01, K-03). A user belongs to exactly one
 * organization, which Better Auth sets as the session's active organization at sign-in.
 * Identity and membership are real; the organization's settings and entitlements are
 * still mock profiles until A4/A8. Deduplicated per request.
 */
export const getSession = cache(async () => {
  const requestHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  const organizationId = session?.session.activeOrganizationId;
  if (!session || !organizationId) redirect("/sign-in");

  const organization = await auth.api.getFullOrganization({
    headers: requestHeaders,
    query: { organizationId, membersLimit: 0 },
  });
  if (!organization) redirect("/sign-in");

  return {
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    organization: {
      id: organization.id,
      name: organization.name,
      code: organization.slug,
      ...profileFor(organization.slug),
    },
  };
});

export type Session = Awaited<ReturnType<typeof getSession>>;
