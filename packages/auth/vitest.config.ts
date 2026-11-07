import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: [fileURLToPath(import.meta.resolve("@flowless/db/vitest-setup"))],
    env: { BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long", BETTER_AUTH_URL: "http://localhost:3000" },
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
