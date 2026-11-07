import { startTestDatabase, tenants, type TestDatabase } from "@flowless/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectAuth } from "./connect";
import type { Auth } from "./auth";

let t: TestDatabase;
let auth: Auth;
let close: () => Promise<void>;

beforeAll(async () => {
  t = await startTestDatabase();
  // The runtime auth role: reaches only the `auth` schema.
  ({ auth, close } = connectAuth(t.urlFor("flowless_auth_api")));
});
afterAll(async () => {
  await close?.();
  await t?.stop();
});

const password = "correct horse battery";

/** Signs in and returns the cookie header for follow-up calls. */
async function signIn(email: string): Promise<Headers> {
  const { headers } = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  const cookie = headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return new Headers({ cookie });
}

// K-01, K-03, NF-05: identity and membership live in the auth schema, via the auth role.
describe("better auth", () => {
  it("signs up, creates an organization and makes it the session's active tenant", async () => {
    const { user } = await auth.api.signUpEmail({ body: { email: "amina@example.test", password, name: "Amina" } });
    const org = await auth.api.createOrganization({ body: { name: "Amina Water", slug: "amina-water", userId: user.id } });

    const headers = await signIn("amina@example.test");
    await auth.api.setActiveOrganization({ headers, body: { organizationId: org!.id } });

    const session = await auth.api.getSession({ headers });
    expect(session?.user.email).toBe("amina@example.test");
    expect(session?.session.activeOrganizationId).toBe(org!.id);
  });

  it("issues uuid organization ids, which tenant RLS policies require", async () => {
    const { user } = await auth.api.signUpEmail({ body: { email: "baraka@example.test", password, name: "Baraka" } });
    const org = await auth.api.createOrganization({ body: { name: "Baraka Water", slug: "baraka-water", userId: user.id } });
    expect(org!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("refuses to activate an organization the user is not a member of", async () => {
    await auth.api.signUpEmail({ body: { email: "outsider@example.test", password, name: "Outsider" } });
    const headers = await signIn("outsider@example.test");
    await expect(
      auth.api.setActiveOrganization({ headers, body: { organizationId: tenants.a.id } }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("rejects a wrong password", async () => {
    await expect(
      auth.api.signInEmail({ body: { email: "amina@example.test", password: "wrong password!" } }),
    ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
  });
});
