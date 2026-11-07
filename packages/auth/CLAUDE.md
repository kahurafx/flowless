# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## `@flowless/auth`

Better Auth 1.7 with the `organization` and `twoFactor` plugins. Identity, sessions, organizations (the tenant table), members and invitations. Ownership and the `auth`-schema exception to tenant RLS are in `docs/build-plan.md` → "Identity and tenancy". Use the Better Auth skills (`best-practices`, `organization`, `twoFactor`) and check docs that match the installed version.

- `src/auth.ts`: `createAuth(db)`. `db` must connect as a member of `flowless_auth` (`DATABASE_AUTH_URL`), never the tenant role.
- `auth.cli.ts`: entry point for the Better Auth CLI only (a drizzle mock, no database).
- After changing plugins or auth options, regenerate the schema and then the migration:
  1. `pnpm --filter @flowless/auth auth:generate`, which writes `packages/db/src/schema/auth.ts`. Never hand-edit that file.
  2. `pnpm db:generate`.
  3. Review the SQL.
- Ids are UUIDs (`advanced.database.generateId: "uuid"`), because module RLS policies compare `organization_id` as `uuid`.
- This is the only package allowed to import `@flowless/db/auth-schema`. Other modules learn about organizations from events this package publishes.
- Holds no tRPC procedures. `packages/api` calls it to resolve the session.
- Phase 1 work: secret and base URL from env, web handler, Expo client, access control, audit hooks, lifecycle events.
- Server-only (Node). Mobile uses `better-auth` client APIs and `@better-auth/expo`, never this package.
