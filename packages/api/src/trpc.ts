import { initTRPC, TRPCError } from "@trpc/server";
import type { Caller } from "@flowless/auth";
import { enqueueEvent, memberPermission, recordAudit, withTenant, type AuditEntry, type AuditSource, type Database } from "@flowless/db";
import { effectivePermissions, type ModuleKey, type Permission, type Scope } from "@flowless/shared-types";
import { eq } from "drizzle-orm";
import superjson from "superjson";
import { loadEntitlements } from "./kernel/entitlement-store";
import type { EventDef } from "./kernel/events";
import { enqueueJob, type EnqueueOptions, type JobDef } from "./kernel/jobs";
import { loadScope } from "./kernel/scope";

/**
 * Who is calling: the parts of the Better Auth caller the API relies on. Derived from
 * `Caller` so there is one model of the caller; `connectAuth().getCaller` returns it.
 * `member` is the caller's one membership, read fresh for every request.
 */
export interface Session {
  user: Pick<Caller["user"], "id" | "name" | "email">;
  session: Pick<Caller["session"], "id" | "activeOrganizationId">;
  member: Caller["member"];
}

export interface Context {
  db: Database;
  session: Session | null;
  /** Where the request came from, for the audit log (K-06). Defaults to "api". */
  source?: AuditSource;
}

/** What a procedure says about a change; the kernel adds tenant, actor and source. */
export type AuditNote = Omit<AuditEntry, "organizationId" | "source" | "actorUserId" | "actorLabel">;

// superjson carries bigint (money in minor units, B-18) and Date across the wire.
const t = initTRPC.context<Context>().create({ transformer: superjson });

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;

/**
 * Runs the whole procedure inside `withTenant`, exposing the tenant-scoped
 * transaction as `ctx.tx` (K-01), what the caller may do as `ctx.permissions`
 * (role defaults plus extra grants, K-03) and which part of the organization they cover
 * as `ctx.scope()` (scope restrictions, K-03), and the licensed modules as
 * `ctx.entitlements()` (K-04). Both load on first use. `ctx.audit(note)` appends to the
 * audit log in the same transaction, so the entry commits only with the change (K-06).
 * `ctx.publish(event, payload)` writes to the outbox the same way (K-09), and
 * `ctx.enqueue(job, payload)` queues background work owned by the caller (NF-12, NF-24). The tenant is the caller's membership, and it
 * must match the session's active organization, so a removed member loses access at once.
 * In tRPC v11 `next()` reports failure as `{ ok: false }` instead of throwing, so
 * re-throw to roll the transaction back.
 */
export const tenantProcedure = t.procedure.use(({ ctx, next }) => {
  const { session } = ctx;
  if (!session) throw new TRPCError({ code: "UNAUTHORIZED" });
  const organizationId = session.session.activeOrganizationId;
  const member = session.member;
  if (!organizationId || member?.organizationId !== organizationId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "No active organization" });
  }

  return withTenant(ctx.db, organizationId, async (tx) => {
    const grants = await tx
      .select({ permission: memberPermission.permission })
      .from(memberPermission)
      .where(eq(memberPermission.userId, session.user.id));
    const permissions = effectivePermissions(
      member.role,
      grants.map((g) => g.permission),
    );
    let scope: Promise<Scope> | undefined;
    let entitlements: Promise<ModuleKey[]> | undefined;
    const result = await next({
      ctx: {
        session,
        organizationId,
        role: member.role,
        permissions,
        tx,
        scope: () => (scope ??= loadScope(tx, session.user.id)),
        entitlements: () => (entitlements ??= loadEntitlements(tx)),
        audit: (note: AuditNote) =>
          recordAudit(tx, {
            ...note,
            organizationId,
            source: ctx.source ?? "api",
            actorUserId: session.user.id,
            actorLabel: session.user.name,
          }),
        publish: <T>(event: EventDef<T>, payload: T, options: { id?: string } = {}) =>
          enqueueEvent(tx, {
            organizationId,
            type: event.type,
            version: event.version,
            payload: event.schema.parse(payload),
            id: options.id,
          }),
        enqueue: <T>(def: JobDef<T>, payload: T, options: Omit<EnqueueOptions, "createdByUserId"> = {}) =>
          enqueueJob(tx, organizationId, def, payload, { ...options, createdByUserId: session.user.id }),
      },
    });
    if (!result.ok) throw result.error;
    return result;
  });
});

function assertPermissions(permissions: ReadonlySet<Permission>, required: readonly Permission[]) {
  const missing = required.filter((p) => !permissions.has(p));
  if (missing.length) throw new TRPCError({ code: "FORBIDDEN", message: `Missing permission: ${missing.join(", ")}` });
}

/** A tenant procedure the caller may run only with every listed permission (K-03). */
export function permittedProcedure(...required: [Permission, ...Permission[]]) {
  return tenantProcedure.use(({ ctx, next }) => {
    assertPermissions(ctx.permissions, required);
    return next();
  });
}

/**
 * The only builder module routers use (K-04, NF-03). An unlicensed module answers
 * NOT_FOUND, as if it were not mounted, before anything else runs; then every listed
 * permission is required (K-03).
 */
export function moduleProcedure(module: ModuleKey, ...required: Permission[]) {
  return tenantProcedure.use(async ({ ctx, next }) => {
    if (!(await ctx.entitlements()).includes(module)) {
      throw new TRPCError({ code: "NOT_FOUND", message: `${module} is not licensed for this organization` });
    }
    assertPermissions(ctx.permissions, required);
    return next({ ctx: { module } });
  });
}

/**
 * The message of an error the caller can act on (FORBIDDEN, NOT_FOUND, …), or null for
 * internal errors, whose details must not reach the user. For apps calling in-process.
 */
export function clientErrorMessage(error: unknown): string | null {
  return error instanceof TRPCError && error.code !== "INTERNAL_SERVER_ERROR" ? error.message : null;
}
