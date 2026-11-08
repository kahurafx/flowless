# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Flowless is a pnpm + Turborepo monorepo (early scaffold stage) with a Next.js web app, an Expo mobile app, and shared internal packages under the `@flowless/*` scope.

## Commands

Run from the repo root (pnpm 10 is the package manager; Turbo orchestrates tasks):

```bash
pnpm install
pnpm dev            # turbo run dev — all apps with a dev script (web)
pnpm build          # turbo run build
pnpm lint           # turbo run lint
pnpm check-types    # turbo run check-types
```

Target one workspace with Turbo's filter, e.g. `pnpm turbo run check-types --filter=web` or `--filter=@flowless/db`, or run a package script directly: `pnpm --filter web dev`.

`pnpm dev` also starts `apps/worker` (the outbox dispatcher). Replay an organization's events to one consumer with `pnpm --filter worker replay -- --consumer <name> --organization <id> [--since <date>]`.

Mobile (`apps/mobile`) is not started by `pnpm dev`; it needs a development build (MapLibre is native): `pnpm --filter mobile android` / `ios` once, then `pnpm --filter mobile start`. `pnpm lint` runs its `expo lint` (with the module-boundaries rule), `pnpm check-types` its `tsc`, and `pnpm test` its Vitest unit tests. It reads `EXPO_PUBLIC_API_URL` (default: port 3000 on the machine serving the bundle). See `apps/mobile/CLAUDE.md`.

Local services and database:

```bash
pnpm bootstrap      # copy .env.example → .env (if missing), docker compose up (Postgres 17 with PostGIS :54320, Redis :63790), migrate, seed
pnpm db:generate    # drizzle-kit generate after changing packages/db/src/schema
pnpm db:migrate     # bootstrap roles + apply migrations (uses DATABASE_ADMIN_URL)
pnpm db:seed        # packages/seed: dev organizations, users, settings, areas, routes and scopes. Code MAJISAFI, wanjiru@majisafi.test (owner) or usernames baraka (clerk) / achieng (cashier, limited to Kahawa West), password flowless-dev-password
pnpm test           # turbo run test — Vitest; integration tests start their own Postgres via Testcontainers (Docker required)
```

Env lives in the root `.env`. `apps/web` loads it with `process.loadEnvFile` in `next.config.ts` (already-set variables win; a missing file is fine). The web DB pool is created on first request (`src/server/db.ts`), so `next build` needs no database env.

## Architecture

- `apps/web` (package name `web`): Next.js 16 App Router, React 19, Tailwind v4 (via `@tailwindcss/turbopack` loader in `next.config.ts`), shadcn/ui with the `base-nova` style on `@base-ui/react` (not Radix). `cacheComponents` and `partialPrefetching` are enabled. Path alias `@/*` → `src/*`. `check-types` runs `next typegen` before `tsc`.
- `apps/mobile` (package name `mobile`): the offline-first technician app, Expo SDK 58 / React Native 0.88 with Expo Router (routes in `src/app/`), ported from Majimap's field app. A tRPC client (`import type { AppRouter }` only) and a Better Auth Expo client; local-first state in sqlite with an ops queue that syncs idempotent, client-minted-id calls; job, map, capture and review screens; photos through the file service. Structure, sync and env vars are in `apps/mobile/CLAUDE.md`.
- `packages/*` — internal packages, all ESM, **no build step**: each exports raw TypeScript via `"exports": { ".": "./src/index.ts" }` and is consumed directly by the apps' bundlers. Scripts: `lint`, `check-types`, and `test` where a package has tests.
  - `shared-types` — types and constants shared across web and mobile (sign-in identifiers, permissions, enums).
  - `api` — tRPC: the only place procedures live (`kernel/` plus one folder per module under `modules/`).
  - `db` — Drizzle schema per module, migrations, runtime roles, RLS policies, `withTenant`.
  - `auth` — Better Auth (organization + twoFactor plugins); owns the `auth` Postgres schema, generated into `packages/db/src/schema/auth.ts` by `pnpm --filter @flowless/auth auth:generate`.
  - `seed` — `pnpm db:seed`: dev data, identities from `@flowless/auth/dev-seed`, everything else through the API as the owner.
  - `network` — pure graph traces (directional, isolation, subnetwork and DMA membership, geo helpers) shared by API, web and mobile; ported from Majimap, no I/O. `billing-engine` (planned, Phase 4) — pure billing library, no I/O. `apps/worker` — outbox dispatcher and job runner.
- Target layout and module boundary rules: `docs/build-plan.md` → "Code layout". Follow it when adding code; update it in the same change if the layout has to move.
  - `typescript-config` — `base.json` (strict, `noUncheckedIndexedAccess`, Bundler resolution, `noEmit`); packages extend it. The apps use their own framework tsconfigs instead.
  - `eslint-config` — flat config exported as `@flowless/eslint-config/base`; packages re-export it from `eslint.config.js`. Web uses `eslint-config-next` instead.
- New internal packages should follow the same shape (`@flowless/<name>`, `workspace:*` deps, extend the shared tsconfig/eslint config).

## Framework-specific rules (read the per-app AGENTS.md)

Both apps pin versions newer than typical training data, and each has an `AGENTS.md` that must be followed when working there:

- **Web** (`apps/web/AGENTS.md`): Next.js 16 has breaking changes — read the relevant guide in `apps/web/node_modules/next/dist/docs/` before writing Next.js code and heed deprecation notices. The AGENTS.md block is regenerated by `next dev`; commit it rather than removing it.
- **Mobile** (`apps/mobile/AGENTS.md`): don't trust memory for Expo APIs — check the versioned docs at `https://docs.expo.dev/versions/v58.0.0/` or `https://docs.expo.dev/llms.txt`. Add dependencies with `npx expo install <pkg>` (not `pnpm add`) so versions match the SDK. Never hand-edit generated `ios/`/`android/` dirs; configure native behavior via `app.json` and config plugins. Run lint (`npx expo lint`) and typecheck before calling a mobile task done.

# Flowless: rules for every change
- Read docs/requirements.md first (what to build; requirement IDs), then docs/build-plan.md (which phase owns the ID and where the code goes). Cite requirement IDs. Propose a task list before writing code.
- docs/billing-engine.html is the executable reference for requirements §6; where they disagree, requirements.md wins.
- Money is integer minor units (bigint in DB). Never floats. Round once per line.
- Every table has organization_id and a Postgres RLS policy. No query bypasses it. The only exception is Better Auth's `auth` schema, isolated by role instead (only `packages/auth` touches it; see docs/build-plan.md → Identity and tenancy).
- Modules never read each other's tables. They talk through events (transactional outbox) or a published interface. A module that is not licensed must not break any other.
- Ledger, readings and invoices are append-only. Corrections are reversals, credit notes, debit notes or re-bills. Never UPDATE posted money.
- Derived values (previous reading, balance, statement running total) are computed, never stored in editable fields.
- Behavior is configuration per organization, never per-tenant code.
- Every background job failure becomes a visible exception with owner and age. No silent failures.
- Add or update tests with every change. packages/billing-engine must keep its invariant and property tests green.
- Small commits, conventional messages, no unrelated refactors.
- A phase is done only when its acceptance checks pass. Tests are off in CI for now, so run `pnpm test` locally before calling a step done. Do not start the next phase on red tests.

