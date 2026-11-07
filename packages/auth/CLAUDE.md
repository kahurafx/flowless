# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## `@flowless/auth`

Better Auth 1.7 with the `organization`, `twoFactor` and `username` plugins. Identity, sessions, organizations (the tenant table), members and invitations. Ownership and the `auth`-schema exception to tenant RLS are in `docs/build-plan.md` → "Identity and tenancy". Use the Better Auth skills (`best-practices`, `organization`, `twoFactor`) and check docs that match the installed version.

- `src/auth.ts`: `createAuth(db)` and the `AuthSession` type. `db` must connect as a member of `flowless_auth` (`DATABASE_AUTH_URL`), never the tenant role. Secret and base URL come from `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL`. Rate limits (NF-05) are on everywhere, stricter on sign-in and two-factor; storage is in-memory per instance until web scales out.
- Tenancy rules (requirements §1), all enforced server-side in `src/auth.ts`: one organization per user (hooks plus the `member_user_id_unique` index in `packages/db/migrations/0003_auth_single_membership.sql`); users cannot create organizations; sign-in requires the organization code in the `x-flowless-organization` header (`ORGANIZATION_CODE_HEADER` from `@flowless/shared-types`); email sign-in only for owners and admins; staff usernames are stored as `<code>.<name>` (`qualifiedUsername`); the session's active organization is set from the membership at creation and `/organization/set-active` is disabled. Membership lookups live in `src/membership.ts`.
- Roles (K-03): `src/access.ts` registers the default roles from `@flowless/shared-types` (`DEFAULT_ROLES`) with Better Auth access control. Only owner and admin keep Better Auth's member and invitation management. Flowless resource names must never reuse Better Auth's (`organization`, `member`, `invitation`, `team`, `ac`). `beforeAddMember` rejects unknown role names, which Better Auth only checks on invitations and role changes. Extra per-member permissions are not here: they live in `kernel.member_permission`, managed through `packages/api`.
- Audit (K-06): `src/audit.ts` and the hooks in `src/auth.ts` record sign-ins (refused ones too, including the organization-code check), account changes (two-factor, password), member removals and role changes (previous role read in the before hook), and invitations, via the auth role's insert-only grant on `kernel.audit_log`. Server-only endpoints such as `addMember` run hooks with path `/`, so member adds and organization creation are audited from `organizationHooks` instead. Calls without request headers are recorded as `system`.
- `src/connect.ts`: `connectAuth(databaseUrl)` builds the auth-schema connection, so apps never import the auth schema. Its `getCaller(headers)` returns the session plus the current membership, read on every call, so role changes and removals apply at once. `apps/web` creates it lazily in `src/server/auth.ts` and mounts `/api/auth/[...all]`.
- `src/dev-seed.ts` (export `@flowless/auth/dev-seed`, run by `packages/seed` through `pnpm db:seed`): `seedDevIdentities(url)`, idempotent dev organizations and users (codes `majisafi` and `kilima`; owners `wanjiru@majisafi.test` and `otieno@kilima.test`, staff `baraka` (clerk), `achieng` (cashier), `chebet` (technician); password `flowless-dev-password`). Refuses to run with `NODE_ENV=production`.
- `src/auth.test.ts` runs Better Auth against a real database through the auth role (shared test Postgres from `@flowless/db/vitest-setup`).
- `auth.cli.ts`: entry point for the Better Auth CLI only (a drizzle mock, no database).
- After changing plugins or auth options, regenerate the schema and then the migration:
  1. `pnpm --filter @flowless/auth auth:generate`, which writes `packages/db/src/schema/auth.ts`. Never hand-edit that file.
  2. `pnpm db:generate`.
  3. Review the SQL.
- Ids are UUIDs (`advanced.database.generateId: "uuid"`), because module RLS policies compare `organization_id` as `uuid`.
- This is the only package allowed to import `@flowless/db/auth-schema`. Other modules learn about organizations from events this package publishes.
- Holds no tRPC procedures. `packages/api` calls it to resolve the session.
- Still to come in Phase 1: Expo client, audit hooks (A5), organization lifecycle events (A6), enforced MFA enrolment for staff.
- Server-only (Node). Mobile uses `better-auth` client APIs and `@better-auth/expo`, never this package.
