# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## `@flowless/eslint-config`

Shared ESLint 9 flat config, exported as `@flowless/eslint-config/base` (`base.js`): `@eslint/js` recommended + `typescript-eslint` recommended, ignoring `dist/` and `node_modules/`.

- Each `packages/*` workspace uses it via `eslint.config.js`: `import { config } from "@flowless/eslint-config/base"; export default config;`
- Not used by the apps: web uses `eslint-config-next`, mobile uses `npx expo lint`.
- To add a variant (e.g. a React config), add a new file and a matching entry in `exports` in `package.json`.
- Verify changes with `pnpm lint` from the root.
