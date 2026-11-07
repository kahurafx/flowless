# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## `@flowless/auth`

Better Auth 1.7 with the `organization` and `twoFactor` plugins. Identity, sessions, organizations (the tenant table), members and invitations. Ownership and the `auth`-schema exception to tenant RLS are in `docs/build-plan.md` → "Identity and tenancy". Use the Better Auth skills (`best-practices`, `organization`, `twoFactor`) and check docs that match the installed version.

- `src/auth.ts`: `createAuth(db)` and the `AuthSession` type. `db` must connect as a member of `flowless_auth` (`DATABASE_AUTH_URL`), never the tenant role. Secret and base URL come from `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL`. Rate limits (NF-05) are on everywhere, stricter on sign-in and two-factor; storage is in-memory per instance until web scales out.
- `src/connect.ts`: `connectAuth(databaseUrl)` builds the auth-schema connection, so apps never import the auth schema. `apps/web` creates it lazily in `src/server/auth.ts` and mounts `/api/auth/[...all]`.
- `scripts/seed-dev.ts` (`pnpm db:seed`): idempotent dev users and organizations (`maji-safi`, `kilima`; password `flowless-dev-password`). Refuses to run with `NODE_ENV=production`.
- `src/auth.test.ts` runs Better Auth against a real database through the auth role (shared test Postgres from `@flowless/db/vitest-setup`).
- `auth.cli.ts`: entry point for the Better Auth CLI only (a drizzle mock, no database).
- After changing plugins or auth options, regenerate the schema and then the migration:
  1. `pnpm --filter @flowless/auth auth:generate`, which writes `packages/db/src/schema/auth.ts`. Never hand-edit that file.
  2. `pnpm db:generate`.
  3. Review the SQL.
- Ids are UUIDs (`advanced.database.generateId: "uuid"`), because module RLS policies compare `organization_id` as `uuid`.
- This is the only package allowed to import `@flowless/db/auth-schema`. Other modules learn about organizations from events this package publishes.
- Holds no tRPC procedures. `packages/api` calls it to resolve the session.
- Still to come in Phase 1: Expo client, access control (A2), audit hooks (A5), organization lifecycle events (A6), enforced MFA enrolment for staff.
- Server-only (Node). Mobile uses `better-auth` client APIs and `@better-auth/expo`, never this package.
