import { cookies } from "next/headers";
import { cache } from "react";
import { organizations } from "@/mocks/tenants";

// UI track seam (docs/build-plan.md). Phase 1 A1 replaces this with the Better Auth session
// and its activeOrganizationId; the cookie only stands in for "switch organization".
export const MOCK_ORG_COOKIE = "flowless-mock-org";

/** The signed-in user and their active organization. Deduplicated per request. */
export const getSession = cache(async () => {
  const activeId = (await cookies()).get(MOCK_ORG_COOKIE)?.value;
  const organization = organizations.find((o) => o.id === activeId) ?? organizations[0]!;
  return {
    user: organization.currentUser,
    organization,
    memberships: organizations.map(({ id, name }) => ({ id, name })),
  };
});

export type Session = Awaited<ReturnType<typeof getSession>>;
