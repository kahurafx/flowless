import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // One shared Postgres per run; each test file clones the migrated template.
    globalSetup: [fileURLToPath(new URL("./src/vitest-setup.ts", import.meta.url))],
    // Image pulls on a cold machine can be slow.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
