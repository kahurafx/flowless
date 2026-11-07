import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createDatabase, type Database } from "./client";
import { migrateDatabase } from "./migrate";
import { organizationSettings } from "./schema";
import { organization } from "./schema/auth";

/** Fixed canary tenants (NF-02). Tests assert tenant B's ids never appear under tenant A. */
export const tenants = {
  a: { id: "00000000-0000-4000-8000-00000000000a", name: "Canary Water A", slug: "canary-a" },
  b: { id: "00000000-0000-4000-8000-00000000000b", name: "Canary Water B", slug: "canary-b" },
} as const;

export interface TestDatabase {
  /** Runtime tenant role (flowless_app): subject to RLS. Use this in tests. */
  app: Database;
  /** Runtime auth role (flowless_auth): only the `auth` schema. */
  auth: Database;
  /** Owner/superuser: bypasses RLS. Only for seeding and checking raw state. */
  admin: Database;
  /** Owner connection string, for tests that re-run `migrateDatabase`. */
  adminUrl: string;
  /** Builds a runtime connection string for `user` (password = user name). */
  urlFor: (user: string) => string;
  stop: () => Promise<void>;
}

/** Starts a throwaway Postgres, migrates it and seeds the two canary tenants. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const adminUrl = container.getConnectionUri();
  const urlFor = (user: string) => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = user;
    return url.toString();
  };
  const urls = { app: urlFor("flowless_api"), auth: urlFor("flowless_auth_api") };

  await migrateDatabase(adminUrl, urls);
  const admin = createDatabase(adminUrl);
  const app = createDatabase(urls.app, { max: 1 });
  const auth = createDatabase(urls.auth, { max: 1 });

  const all = Object.values(tenants);
  await admin.db.insert(organization).values(all.map((t) => ({ ...t, createdAt: new Date() })));
  await admin.db
    .insert(organizationSettings)
    .values(all.map((t) => ({ organizationId: t.id, currency: "KES", timeZone: "Africa/Nairobi", locale: "en-KE" })));

  return {
    app: app.db,
    auth: auth.db,
    admin: admin.db,
    adminUrl,
    urlFor,
    stop: async () => {
      await Promise.all([app.close(), auth.close(), admin.close()]);
      await container.stop();
    },
  };
}
