# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## `@flowless/eslint-config`

Shared ESLint 9 flat config, exported as `@flowless/eslint-config/base` (`base.js`): `@eslint/js` recommended + `typescript-eslint` recommended, ignoring `dist/` and `node_modules/`.

- Each `packages/*` workspace uses it via `eslint.config.js`: `import { config } from "@flowless/eslint-config/base"; export default config;`
- Not used by the apps: web uses `eslint-config-next`, mobile uses `eslint-config-expo` through `npx expo lint`. Both add `boundaries` from `./boundaries` (mobile's `eslint.config.js` is CommonJS, so it loads the ES module with a dynamic `import()`).
- To add a variant (e.g. a React config), add a new file and a matching entry in `exports` in `package.json`.
- `boundaries.js` (export `./boundaries`, included in `base.js` and in web's config): the `flowless/module-boundaries` rule enforcing docs/build-plan.md → Boundary rules by file path. Only `packages/auth` imports `@flowless/db/auth-schema`; `packages/api/src/modules/<m>` and `kernel/` reach another module only through its `index.ts`; a module imports only its own `@flowless/db/schema/<m>`; module code never imports `tenantProcedure`, `permittedProcedure` or `publicProcedure` (only `moduleProcedure`); `apps/mobile` only `import type` from `@flowless/api`. Tests: `boundaries.test.js` (ESLint RuleTester under Vitest, `pnpm --filter @flowless/eslint-config test`).
- `pure.js` (export `./pure`): purity rules for packages that must do no I/O (`packages/billing-engine`): bans `@flowless/db`, `node:*` and Node built-ins, network libraries and globals (`fetch`, axios, http, ...), `Date.now`, `new Date()` and `Math.random`. Spread it after the base config. Test: `pure.test.js`.
- Verify changes with `pnpm lint` from the root.
