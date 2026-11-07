---
name: tRPC
description: How tRPC v11 is used in Flowless (packages/api). Use when adding or changing procedures, routers, middleware, context, the web route handler, or a tRPC client in apps/web or apps/mobile.
---

# tRPC in Flowless

Versions: `@trpc/server` 11.x, `superjson` 2.x, `zod` 4.x. Generic tRPC tutorials online often show v10 APIs; check the installed types in `packages/api/node_modules/@trpc/server/dist` when unsure.

Read `docs/build-plan.md` → "Code layout" and `packages/api/CLAUDE.md` first. Those rules win over anything here.

## Where things live

| File | Role |
| --- | --- |
| `packages/api/src/trpc.ts` | `initTRPC` with the `superjson` transformer, `Context`, `Session`, and base procedures (`publicProcedure`, `tenantProcedure`; `moduleProcedure(module)` lands in Phase 1). |
| `packages/api/src/root.ts` | `appRouter` (one key per kernel area or module), `type AppRouter`, `createCaller`. |
| `packages/api/src/http.ts` | `createTrpcHandler({ db, endpoint })`, a Fetch handler built on `fetchRequestHandler`. Apps never import `@trpc/server`. |
| `packages/api/src/kernel/*.ts`, `src/modules/<module>/router.ts` | Routers. |
| `apps/web/src/app/api/trpc/[trpc]/route.ts` | Exports the handler as `GET` and `POST`. |

## Writing a procedure

```ts
import { z } from "zod";
import { router, tenantProcedure } from "../trpc";

export const exampleRouter = router({
  byId: tenantProcedure
    .input(z.object({ id: z.uuid() }))
    .query(async ({ ctx, input }) => {
      // ctx.tx: transaction already scoped to ctx.session.organizationId (RLS).
      // Never use ctx.db for tenant data; it sees nothing (RLS fails closed).
    }),
});
```

- Tenant data goes only through `ctx.tx` from `tenantProcedure`. `publicProcedure` is for things with no tenant data, such as `health`.
- Validate every input with zod 4. Use top-level formats (`z.uuid()`, `z.email()`), not the deprecated `z.string().uuid()`.
- Money is `bigint` minor units. superjson carries `bigint` and `Date`, so never convert money to `number` for the wire.
- Throw `TRPCError` with a precise code (`NOT_FOUND`, `FORBIDDEN`, `CONFLICT`, `PRECONDITION_FAILED`). Other thrown errors become `INTERNAL_SERVER_ERROR`.
- Long work (billing runs, imports, reconciliation) is enqueued for `apps/worker`, never run inline.

## Middleware gotcha (v11)

`await next()` does **not** throw when the procedure fails. It returns `{ ok: false, error }`. Any middleware that wraps `next()` in a transaction or other resource must re-throw so the work rolls back:

```ts
return withTenant(ctx.db, orgId, async (tx) => {
  const result = await next({ ctx: { tx } });
  if (!result.ok) throw result.error;
  return result;
});
```

## Testing

Use the in-process caller against a real database. Never mock the database or RLS.

```ts
import { startTestDatabase, tenants } from "@flowless/db/testing";
import { createCaller } from "./root";

const caller = createCaller({ db: t.app, session: { userId: "u", organizationId: tenants.a.id } });
```

To test a middleware alone, build a small router in the test file and use `createCallerFactory(router)(ctx)`.

## Clients (when added)

- Web client components: `@trpc/client` plus `@trpc/tanstack-react-query` with `httpBatchLink({ url: "/api/trpc", transformer: superjson })`. In v11 the transformer goes on the link, not on the client. Server components use `createCaller` in-process instead of HTTP.
- Mobile: same link with an absolute URL. Import only `type { AppRouter }` from `@flowless/api`. Add packages with `npx expo install`.
