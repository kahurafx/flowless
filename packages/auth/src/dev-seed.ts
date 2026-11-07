// Dev-only: creates organizations and sign-in users for local testing. Idempotent.
// Organization codes match the web app's mock profiles (apps/web/src/mocks/tenants.ts).
// Run through `pnpm db:seed` (packages/seed), which then seeds kernel data through the API.
import * as authSchema from "@flowless/db/auth-schema";
import { qualifiedUsername, type RoleKey } from "@flowless/shared-types";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createAuth } from "./auth";

export const DEV_PASSWORD = "flowless-dev-password";
const PASSWORD = DEV_PASSWORD;

/** Each user belongs to exactly one organization. */
export const DEV_ORGANIZATIONS = [
  {
    code: "majisafi",
    name: "Maji Safi Water & Sanitation Company",
    settings: { currency: "KES", timeZone: "Africa/Nairobi", locale: "en-KE" },
    owner: { email: "wanjiru@majisafi.test", name: "Wanjiru Kamau" },
    staff: [
      { username: "baraka", name: "Baraka Mwangi", role: "clerk" },
      { username: "achieng", name: "Achieng Otieno", role: "cashier" },
    ],
  },
  {
    code: "kilima",
    name: "Kilima Community Water Project",
    settings: { currency: "KES", timeZone: "Africa/Nairobi", locale: "sw-KE" },
    owner: { email: "otieno@kilima.test", name: "Otieno Odhiambo" },
    staff: [{ username: "chebet", name: "Chebet", role: "technician" }],
  },
] as const satisfies readonly {
  code: string;
  name: string;
  /** Initial settings, sent as organization metadata and applied by the kernel. */
  settings: { currency: string; timeZone: string; locale: string };
  owner: { email: string; name: string };
  staff: readonly { username: string; name: string; role: RoleKey }[];
}[];

/** Creates the dev organizations, owners and staff. `databaseUrl` is DATABASE_AUTH_URL. */
export async function seedDevIdentities(databaseUrl: string) {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed dev users in production");
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client, { schema: authSchema });
  const auth = createAuth(db);

  async function findUser(email: string): Promise<string | undefined> {
    const [row] = await db.select({ id: authSchema.user.id }).from(authSchema.user).where(eq(authSchema.user.email, email));
    return row?.id;
  }

  try {
    for (const org of DEV_ORGANIZATIONS) {
      const ownerId =
        (await findUser(org.owner.email)) ??
        (await auth.api.signUpEmail({ body: { ...org.owner, password: PASSWORD } })).user.id;

      const [existing] = await db
        .select({ id: authSchema.organization.id })
        .from(authSchema.organization)
        .where(eq(authSchema.organization.slug, org.code));
      const organizationId =
        existing?.id ?? (await auth.api.createOrganization({
          body: { name: org.name, slug: org.code, userId: ownerId, metadata: { settings: org.settings } },
        }))!.id;

      for (const person of org.staff) {
        // Staff without email get a reserved .invalid address; they sign in by username.
        const email = `${person.username}@${org.code}.staff.invalid`;
        const existingId = await findUser(email);
        if (existingId) {
          // Keep earlier seeds in step with the roles above.
          await db.update(authSchema.member).set({ role: person.role }).where(eq(authSchema.member.userId, existingId));
          continue;
        }
        const { user } = await auth.api.signUpEmail({
          body: { email, name: person.name, password: PASSWORD, username: qualifiedUsername(org.code, person.username) },
        });
        await auth.api.addMember({ body: { userId: user.id, organizationId, role: person.role } });
      }
    }
  } finally {
    await client.end();
  }
}
