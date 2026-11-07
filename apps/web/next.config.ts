import type { NextConfig } from "next";

// Env lives in the repo-root .env, shared with packages/db scripts. Next only reads
// apps/web/.env*, and @next/env's loadEnvConfig is a no-op once Next has run it.
// loadEnvFile never overrides variables that are already set; CI has no .env file.
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
