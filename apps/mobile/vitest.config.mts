import { defineConfig } from "vitest/config";

// Pure TypeScript only: the sync logic imports nothing from React Native or Expo, so it runs in Node.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
