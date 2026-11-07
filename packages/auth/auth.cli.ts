// Entry point for the Better Auth CLI (`pnpm auth:generate`) only. The mock driver
// lets the CLI read the config without a database.
import * as authSchema from "@flowless/db/auth-schema";
import { drizzle } from "drizzle-orm/postgres-js";
import { createAuth } from "./src/auth";

export const auth = createAuth(drizzle.mock({ schema: authSchema }));
