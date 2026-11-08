// https://docs.expo.dev/guides/using-eslint/
const { defineConfig, globalIgnores } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

// The shared module-boundaries rule is an ES module; load it lazily so this file stays CommonJS for Expo.
module.exports = (async () => {
  const { boundaries } = await import("@flowless/eslint-config/boundaries");
  return defineConfig([
    expoConfig,
    // apps/mobile may only `import type` from @flowless/api (docs/build-plan.md → Boundary rules).
    boundaries,
    {
      rules: {
        // `_`-prefixed bindings are deliberate omissions.
        "@typescript-eslint/no-unused-vars": ["warn", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
      },
    },
    globalIgnores(["dist/**", ".expo/**", "expo-env.d.ts"]),
  ]);
})();
