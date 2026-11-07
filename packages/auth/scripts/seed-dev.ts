// Dev-only: creates organizations and sign-in users for local testing. Idempotent.
// Organization codes match the web app's mock profiles (apps/web/src/mocks/tenants.ts).
import * as authSchema from "@flowless/db/auth-schema";
import { qualifiedUsername, type RoleKey } from "@flowless/shared-types";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createAuth } from "../src/auth";

const url = process.env.DATABASE_AUTH_URL;
if (!url) throw new Error("DATABASE_AUTH_URL must be set (see .env.example)");
if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed dev users in production");

const PASSWORD = "flowless-dev-password";

/** Each user belongs to exactly one organization. */
const organizations = [
  {
    code: "majisafi",
    name: "Maji Safi Water & Sanitation Company",
    owner: { email: "wanjiru@majisafi.test", name: "Wanjiru Kamau" },
    staff: [
      { username: "baraka", name: "Baraka Mwangi", role: "clerk" },
      { username: "achieng", name: "Achieng Otieno", role: "cashier" },
    ],
  },
  {
    code: "kilima",
    name: "Kilima Community Water Project",
    owner: { email: "otieno@kilima.test", name: "Otieno Odhiambo" },
    staff: [{ username: "chebet", name: "Chebet", role: "technician" }],
  },
] as const satisfies readonly {
  code: string;
  name: string;
  owner: { email: string; name: string };
  staff: readonly { username: string; name: string; role: RoleKey }[];
}[];

const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema: authSchema });
const auth = createAuth(db);

async function findUser(email: string): Promise<string | undefined> {
  const [row] = await db.select({ id: authSchema.user.id }).from(authSchema.user).where(eq(authSchema.user.email, email));
  return row?.id;
}

try {
  for (const org of organizations) {
    const ownerId =
      (await findUser(org.owner.email)) ??
      (await auth.api.signUpEmail({ body: { ...org.owner, password: PASSWORD } })).user.id;

    const [existing] = await db
      .select({ id: authSchema.organization.id })
      .from(authSchema.organization)
      .where(eq(authSchema.organization.slug, org.code));
    const organizationId =
      existing?.id ?? (await auth.api.createOrganization({ body: { name: org.name, slug: org.code, userId: ownerId } }))!.id;

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

  console.log("Dev sign-in (password: %s):", PASSWORD);
  for (const org of organizations) {
    console.log(`  ${org.code}: ${org.owner.email} (owner), ${org.staff.map((s) => `${s.username} (${s.role})`).join(", ")}`);
  }
} finally {
  await client.end();
}
