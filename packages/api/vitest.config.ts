import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Shared Postgres from @flowless/db: one container per run, a cloned database per file.
    globalSetup: [fileURLToPath(import.meta.resolve("@flowless/db/vitest-setup"))],
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
