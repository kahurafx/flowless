import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { profileFor } from "@/mocks/tenants";
import { getAuth } from "@/server/auth";

/**
 * The signed-in user, their memberships and the active organization (K-01, K-03).
 * Identity and membership are real (Better Auth); the organization's settings and
 * entitlements are still mock profiles until A4/A8. Deduplicated per request.
 */
export const getSession = cache(async () => {
  const requestHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in");

  const memberships = await auth.api.listOrganizations({ headers: requestHeaders });
  const active = memberships.find((o) => o.id === session.session.activeOrganizationId);
  // Signed in but no organization chosen yet (or it was removed): choose one first.
  if (!active) redirect("/select-organization");

  const profile = profileFor(active.slug);
  return {
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    organization: { id: active.id, name: active.name, slug: active.slug, ...profile },
    memberships: memberships.map(({ id, name }) => ({ id, name })),
  };
});

export type Session = Awaited<ReturnType<typeof getSession>>;
