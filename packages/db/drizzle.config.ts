import { defineConfig } from "drizzle-kit";

// Only `generate` uses this file. Migrations are applied by `pnpm db:migrate`
// (src/migrate.ts), which also bootstraps roles.
export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/schema/index.ts", "./src/schema/auth.ts"],
  out: "./migrations",
  entities: { roles: false },
});
