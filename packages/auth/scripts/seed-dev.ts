// Dev-only: creates sign-in users and organizations for local testing. Idempotent.
// Organization slugs match the web app's mock profiles (apps/web/src/mocks/tenants.ts).
import * as authSchema from "@flowless/db/auth-schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createAuth } from "../src/auth";

const url = process.env.DATABASE_AUTH_URL;
if (!url) throw new Error("DATABASE_AUTH_URL must be set (see .env.example)");
if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed dev users in production");

const PASSWORD = "flowless-dev-password";

const organizations = [
  { slug: "maji-safi", name: "Maji Safi Water & Sanitation Company" },
  { slug: "kilima", name: "Kilima Community Water Project" },
] as const;

const users = [
  // Belongs to both, so the organization switcher has something to switch.
  { email: "wanjiru@majisafi.test", name: "Wanjiru Kamau", owns: "maji-safi", memberOf: ["kilima"] },
  { email: "otieno@kilima.test", name: "Otieno Odhiambo", owns: "kilima", memberOf: [] },
] as const;

const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema: authSchema });
const auth = createAuth(db);

async function userId(email: string, name: string): Promise<string> {
  const [existing] = await db.select({ id: authSchema.user.id }).from(authSchema.user).where(eq(authSchema.user.email, email));
  if (existing) return existing.id;
  const { user } = await auth.api.signUpEmail({ body: { email, name, password: PASSWORD } });
  return user.id;
}

async function organizationId(slug: string, name: string, ownerId: string): Promise<string> {
  const [existing] = await db
    .select({ id: authSchema.organization.id })
    .from(authSchema.organization)
    .where(eq(authSchema.organization.slug, slug));
  if (existing) return existing.id;
  const created = await auth.api.createOrganization({ body: { name, slug, userId: ownerId } });
  if (!created) throw new Error(`Could not create ${slug}`);
  return created.id;
}

try {
  const ids = new Map<string, string>();
  for (const u of users) ids.set(u.email, await userId(u.email, u.name));

  const orgIds = new Map<string, string>();
  for (const org of organizations) {
    const owner = users.find((u) => u.owns === org.slug)!;
    orgIds.set(org.slug, await organizationId(org.slug, org.name, ids.get(owner.email)!));
  }

  for (const u of users) {
    for (const slug of u.memberOf) {
      const organizationId = orgIds.get(slug)!;
      const memberUserId = ids.get(u.email)!;
      const [already] = await db
        .select({ id: authSchema.member.id })
        .from(authSchema.member)
        .where(and(eq(authSchema.member.userId, memberUserId), eq(authSchema.member.organizationId, organizationId)));
      if (!already) await auth.api.addMember({ body: { userId: memberUserId, organizationId, role: "member" } });
    }
  }

  console.log("Dev users (password: %s):", PASSWORD);
  for (const u of users) console.log(`  ${u.email}`);
} finally {
  await client.end();
}
