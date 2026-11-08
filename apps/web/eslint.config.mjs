import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { boundaries } from "@flowless/eslint-config/boundaries";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Only packages/auth reads the auth schema (docs/build-plan.md → Boundary rules).
  boundaries,
  {
    // `_`-prefixed bindings are deliberate omissions, e.g. `const { organizationId: _org, ...rest }`.
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
