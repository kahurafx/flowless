import { defineConfig } from "vitest/config";

export default defineConfig({
  // Integration tests start a Postgres container; give image pulls time on a cold machine.
  test: { hookTimeout: 120_000, testTimeout: 30_000 },
});
