import { migrateDatabase } from "../src/migrate";

const { DATABASE_ADMIN_URL, DATABASE_URL, DATABASE_AUTH_URL } = process.env;
if (!DATABASE_ADMIN_URL || !DATABASE_URL || !DATABASE_AUTH_URL) {
  throw new Error("DATABASE_ADMIN_URL, DATABASE_URL and DATABASE_AUTH_URL must be set (see .env.example)");
}

await migrateDatabase(DATABASE_ADMIN_URL, { app: DATABASE_URL, auth: DATABASE_AUTH_URL });
console.log("Database migrated.");
