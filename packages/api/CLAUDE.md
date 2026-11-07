# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## `@flowless/api`

Reference /trpc skill.

The tRPC layer: every procedure in Flowless lives here. Phase 0 scaffold: `trpc.ts` (superjson, `tenantProcedure`), `root.ts` (`health`, `organization.settings`), `http.ts` (`createTrpcHandler({ endpoint, getDb, getSession })`). `Session` is the narrow slice of `Caller` (from `@flowless/auth`: Better Auth session plus the current membership) the API uses; `tenantProcedure` takes `session.activeOrganizationId` (UNAUTHORIZED without a session, FORBIDDEN without an active organization or when `session.member` is missing or elsewhere) and exposes `ctx.organizationId`, `ctx.role`, `ctx.permissions` (role defaults plus `kernel.member_permission` grants, K-03) and `ctx.tx`. Guard actions with `permittedProcedure("<resource>:<action>")`; the catalogue and default roles are in `@flowless/shared-types` permissions. `kernel/access.ts`: `access.me`, `access.grants`, `access.grant`, `access.revoke`. Apps read error messages with `clientErrorMessage`, never by importing `@trpc/server`. Target layout and boundary rules are in `docs/build-plan.md` → "Code layout". Shared package conventions are in the root `CLAUDE.md`.

- Layout: `src/trpc.ts` (context and base procedures), `src/root.ts` (`appRouter`, `export type AppRouter`), `src/kernel/*`, `src/modules/<module>/{router,service,events,index}.ts`.
- Module routers build procedures only from `moduleProcedure(module)`. That runs `withTenant` (RLS) and the entitlement check. Never use the raw DB client.
- A module touches only its own `@flowless/db` schema. It reaches other modules through their `index.ts` or through events.
- Long-running work is enqueued for `apps/worker`; procedures never run billing, imports or reconciliation inline.
- Server-only package (Node). `apps/web` imports it at runtime. `apps/mobile` may only `import type { AppRouter }`.
- No build step: consumers import `src/index.ts` directly via `exports`. Scripts: `pnpm lint`, `pnpm check-types` (or `pnpm turbo run check-types --filter=@flowless/api`).
