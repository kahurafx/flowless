import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { inject } from "vitest";
import { createDatabase, type Database } from "./client";
import { migrateDatabase } from "./migrate";
import { organizationSettings } from "./schema";
import { organization } from "./schema/auth";

/** Same image as docker-compose.yml: Postgres 17 with PostGIS (GIS, Phase 2). */
const POSTGRES_IMAGE = "postgis/postgis:17-3.5-alpine";

declare module "vitest" {
  export interface ProvidedContext {
    /** Owner connection to the shared test cluster, set by `vitest-setup.ts`. */
    postgresUrl: string;
  }
}

/** Fixed canary tenants (NF-02). Tests assert tenant B's ids never appear under tenant A. */
export const tenants = {
  a: { id: "00000000-0000-4000-8000-00000000000a", name: "Canary Water A", slug: "canarya" },
  b: { id: "00000000-0000-4000-8000-00000000000b", name: "Canary Water B", slug: "canaryb" },
} as const;

/** Migrated and seeded once per test run; every test file gets a fresh copy of it. */
const TEMPLATE = "flowless_template";

/** Runtime login roles are cluster-wide, so every per-file database shares them. */
const runtimeUsers = { app: "flowless_api", auth: "flowless_auth_api" } as const;

function withDatabase(url: string, database: string, user?: string): string {
  const next = new URL(url);
  next.pathname = `/${database}`;
  if (user) {
    next.username = user;
    next.password = user;
  }
  return next.toString();
}

/**
 * Starts one Postgres for the whole run (Vitest global setup), migrates and seeds the
 * template database, and returns the owner URL plus a stop function.
 */
export async function startTestCluster(): Promise<{ url: string; stop: () => Promise<void> }> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();

  const owner = postgres(url, { max: 1, onnotice: () => {} });
  await owner`create database ${owner(TEMPLATE)}`;
  await owner.end();

  const templateUrl = withDatabase(url, TEMPLATE);
  await migrateDatabase(templateUrl, {
    app: withDatabase(url, TEMPLATE, runtimeUsers.app),
    auth: withDatabase(url, TEMPLATE, runtimeUsers.auth),
  });

  const seed = createDatabase(templateUrl, { max: 1 });
  const all = Object.values(tenants);
  await seed.db.insert(organization).values(all.map((t) => ({ ...t, createdAt: new Date() })));
  await seed.db
    .insert(organizationSettings)
    .values(all.map((t) => ({ organizationId: t.id, currency: "KES" })));
  // CREATE DATABASE ... TEMPLATE needs the template to have no open connections.
  await seed.close();

  return { url, stop: () => container.stop().then(() => undefined) };
}

export interface TestDatabase {
  /** Runtime tenant role (flowless_app): subject to RLS. Use this in tests. */
  app: Database;
  /** Runtime auth role (flowless_auth): only the `auth` schema. */
  auth: Database;
  /** Owner/superuser: bypasses RLS. Only for seeding and checking raw state. */
  admin: Database;
  /** Owner connection string for this database, for tests that re-run `migrateDatabase`. */
  adminUrl: string;
  /** Builds a connection string to this database for `user` (password = user name). */
  urlFor: (user: string) => string;
  stop: () => Promise<void>;
}

/**
 * A private, migrated and seeded database for one test file, cloned from the template
 * in the shared cluster. Files can write freely without affecting each other.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const clusterUrl = inject("postgresUrl");
  const name = `test_${randomUUID().replaceAll("-", "")}`;

  const owner = postgres(clusterUrl, { max: 1, onnotice: () => {} });
  await owner`create database ${owner(name)} template ${owner(TEMPLATE)}`;

  const adminUrl = withDatabase(clusterUrl, name);
  const urlFor = (user: string) => withDatabase(clusterUrl, name, user);
  const admin = createDatabase(adminUrl);
  const app = createDatabase(urlFor(runtimeUsers.app), { max: 1 });
  const auth = createDatabase(urlFor(runtimeUsers.auth), { max: 1 });

  return {
    app: app.db,
    auth: auth.db,
    admin: admin.db,
    adminUrl,
    urlFor,
    stop: async () => {
      await Promise.all([app.close(), auth.close(), admin.close()]);
      await owner`drop database if exists ${owner(name)} with (force)`;
      await owner.end();
    },
  };
}
