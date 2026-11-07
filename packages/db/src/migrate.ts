import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** Runtime connection strings. Each login role is a member of exactly one group role. */
export interface RuntimeUrls {
  /** Tenant data, subject to RLS. Member of `flowless_app`. */
  app: string;
  /** Better Auth tables in the `auth` schema. Member of `flowless_auth`. */
  auth: string;
}

async function roleExists(admin: postgres.Sql, name: string): Promise<boolean> {
  const rows = await admin`select 1 from pg_roles where rolname = ${name}`;
  return rows.length > 0;
}

/** Ensures the NOLOGIN group role and the login role from `url` that belongs to it. */
async function ensureRole(admin: postgres.Sql, group: string, url: string): Promise<void> {
  const { username, password } = new URL(url);
  const login = decodeURIComponent(username);
  // ALTER ROLE ... PASSWORD cannot take a bind parameter, so escape the literal.
  const literal = `'${decodeURIComponent(password).replaceAll("'", "''")}'`;

  if (!(await roleExists(admin, group))) {
    await admin`create role ${admin(group)} nologin nobypassrls`;
  }
  if (!(await roleExists(admin, login))) {
    await admin`create role ${admin(login)} login nobypassrls`;
  }
  // Always (re)grant: a login role that already existed outside the group would otherwise
  // connect without the policy role. GRANT of an existing membership is a no-op.
  await admin`grant ${admin(group)} to ${admin(login)}`;
  await admin`alter role ${admin(login)} password ${admin.unsafe(literal)}`;
}

/**
 * Creates the runtime roles (idempotent), then applies pending migrations. Run with the
 * owner connection. Table privileges are granted per schema by the migrations themselves.
 */
export async function migrateDatabase(adminUrl: string, urls: RuntimeUrls): Promise<void> {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await ensureRole(admin, "flowless_app", urls.app);
    await ensureRole(admin, "flowless_auth", urls.auth);
    await migrate(drizzle(admin), { migrationsFolder });
  } finally {
    await admin.end();
  }
}
