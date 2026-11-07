# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## `@flowless/seed`

Dev data for local testing: `pnpm db:seed` (root) runs `src/seed-dev.ts`. Idempotent; refuses `NODE_ENV=production`. Needs `DATABASE_AUTH_URL` and `DATABASE_URL` from the root `.env`.

- Identities (organizations, owners, staff) come from `seedDevIdentities` in `@flowless/auth/dev-seed`, the only code allowed to touch the `auth` schema.
- Everything else is written through the real API: it signs in as each owner with the organization code, resolves the caller with `getCaller`, and uses `createCaller`, so seeds obey permissions, validation and RLS. Settings come from the `organization.created` event (the seed drains the outbox, as the worker would; initial settings are in `DEV_ORGANIZATIONS` in `@flowless/auth/dev-seed`). The one exception is licences, set with `setEntitlements` because only Flowless licenses (MAJISAFI has the foundation plus communications, collections and reporting; KILIMA the foundation only).
- Area and route names match the web mocks (`apps/web/src/mocks/accounts.ts`). Add new dev data here as each module's procedures land; nothing imports this package.
