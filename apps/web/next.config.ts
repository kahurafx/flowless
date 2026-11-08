import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Env lives in the repo-root .env, shared with packages/db scripts. Next only reads
// apps/web/.env*, and @next/env's loadEnvConfig is a no-op once Next has run it.
// loadEnvFile never overrides variables that are already set; CI has no .env file.
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

// MapLibre's worker is served as a plain file (the map code sets its URL): bundling it breaks
// under Turbopack. Copying here keeps it in step with the installed version for dev, build and start.
{
  const dist = join(dirname(createRequire(import.meta.url).resolve("maplibre-gl/package.json")), "dist");
  const target = fileURLToPath(new URL("./public/maplibre/", import.meta.url));
  mkdirSync(target, { recursive: true });
  for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) copyFileSync(join(dist, file), join(target, file));
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
