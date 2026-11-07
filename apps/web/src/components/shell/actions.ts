"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { MOCK_ORG_COOKIE } from "@/data/session";
import { organizations } from "@/mocks/tenants";

/** Mock "switch organization". Phase 1 calls Better Auth's setActive instead. */
export async function switchOrganization(organizationId: string) {
  if (!organizations.some((o) => o.id === organizationId)) throw new Error("Unknown organization");
  (await cookies()).set(MOCK_ORG_COOKIE, organizationId, { path: "/", sameSite: "lax", httpOnly: true });
  // Pages under the old tenant (an account, a record) mean nothing in the new one.
  redirect("/");
}
