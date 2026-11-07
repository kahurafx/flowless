# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## `@flowless/api`

Reference /trpc skill.

The tRPC layer: every procedure in Flowless lives here. Phase 0 scaffold: `trpc.ts` (superjson, `tenantProcedure`), `root.ts` (`health`, `organization.settings`), `http.ts` (`createTrpcHandler({ endpoint, getDb, getSession })`). `Session` is the narrow slice of Better Auth's `AuthSession` the API uses; `tenantProcedure` takes `session.activeOrganizationId` (UNAUTHORIZED without a session, FORBIDDEN without an active organization) and exposes `ctx.organizationId` and `ctx.tx`. Target layout and boundary rules are in `docs/build-plan.md` → "Code layout". Shared package conventions are in the root `CLAUDE.md`.

- Layout: `src/trpc.ts` (context and base procedures), `src/root.ts` (`appRouter`, `export type AppRouter`), `src/kernel/*`, `src/modules/<module>/{router,service,events,index}.ts`.
- Module routers build procedures only from `moduleProcedure(module)`. That runs `withTenant` (RLS) and the entitlement check. Never use the raw DB client.
- A module touches only its own `@flowless/db` schema. It reaches other modules through their `index.ts` or through events.
- Long-running work is enqueued for `apps/worker`; procedures never run billing, imports or reconciliation inline.
- Server-only package (Node). `apps/web` imports it at runtime. `apps/mobile` may only `import type { AppRouter }`.
- No build step: consumers import `src/index.ts` directly via `exports`. Scripts: `pnpm lint`, `pnpm check-types` (or `pnpm turbo run check-types --filter=@flowless/api`).
