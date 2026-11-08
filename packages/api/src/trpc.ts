import { initTRPC, TRPCError } from "@trpc/server";
import type { Caller } from "@flowless/auth";
import { enqueueEvent, memberPermission, recordAudit, supportGrant, withTenant, type AuditEntry, type AuditSource, type Database } from "@flowless/db";
import { effectivePermissions, SUPPORT_PERMISSIONS, type ModuleKey, type Permission, type Scope } from "@flowless/shared-types";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import superjson from "superjson";
import { requestApproval, type ApprovalDef, type RequestApproval } from "./kernel/approval-store";
import { readSetting, type SettingDef } from "./kernel/config-store";
import { loadEntitlements } from "./kernel/entitlement-store";
import { notify, type Notify } from "./kernel/notification-store";
import type { EventDef } from "./kernel/events";
import { enqueueJob, type EnqueueOptions, type JobDef } from "./kernel/jobs";
import { loadScope } from "./kernel/scope";
import type { Storage } from "./kernel/storage";

/**
 * Who is calling: the parts of the Better Auth caller the API relies on. Derived from
 * `Caller` so there is one model of the caller; `connectAuth().getCaller` returns it.
 * `member` is the caller's one membership, read fresh for every request.
 */
export interface Session {
  user: Pick<Caller["user"], "id" | "name" | "email">;
  session: Pick<Caller["session"], "id" | "activeOrganizationId">;
  member: Caller["member"];
  /**
   * Set for a Flowless support engineer (K-12), who is never a member: `member` is null
   * and access comes from this grant in the active organization, checked on every call.
   */
  support?: { grantId: string };
}

export interface Context {
  db: Database;
  session: Session | null;
  /** Where the request came from, for the audit log (K-06). Defaults to "api". */
  source?: AuditSource;
  /** Object storage for the file service (K-08). Defaults to the environment's. */
  storage?: Storage;
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
 * `ctx.enqueue(job, payload)` queues background work owned by the caller (NF-12, NF-24).
 * `ctx.config(setting, at?)` reads the organization's value in force (K-10), and
 * `ctx.requestApproval(kind, input)` asks for an approval as the caller, audited (K-05).
 * `ctx.notify(input)` notifies a member in-app or through Communications (K-07). The tenant is the caller's membership, and it
 * must match the session's active organization, so a removed member loses access at once.
 * A support session (K-12) instead needs a live grant on every call, may only run queries
 * with read permissions, and each call is audited.
 * In tRPC v11 `next()` reports failure as `{ ok: false }` instead of throwing, so
 * re-throw to roll the transaction back.
 */
export const tenantProcedure = t.procedure.use(({ ctx, next, path, type }) => {
  const { session } = ctx;
  if (!session) throw new TRPCError({ code: "UNAUTHORIZED" });
  const organizationId = session.session.activeOrganizationId;
  const member = session.member;
  const support = session.support;
  if (!organizationId || (!support && member?.organizationId !== organizationId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "No active organization" });
  }
  // A refused support call is recorded in its own transaction, since the call's rolls back.
  const refuse = async (error: TRPCError) => {
    await withTenant(ctx.db, organizationId, (tx) =>
      recordAudit(tx, {
        organizationId,
        source: "support",
        actorUserId: null,
        actorLabel: `Flowless support: ${session.user.email}`,
        action: "support.refused",
        subjectType: "support_grant",
        subjectId: support!.grantId,
        after: { path, code: error.code },
        reason: error.message,
      }),
    );
    throw error;
  };
  if (support && type !== "query") return refuse(new TRPCError({ code: "FORBIDDEN", message: "Support access is read-only" }));

  const run = withTenant(ctx.db, organizationId, async (tx) => {
    let role: string;
    let permissions: ReadonlySet<Permission>;
    const actor = support
      ? { actorUserId: null, actorLabel: `Flowless support: ${session.user.email}`, source: "support" as const }
      : { actorUserId: session.user.id, actorLabel: session.user.name, source: ctx.source ?? "api" };
    if (support) {
      const now = new Date();
      const [grant] = await tx
        .select({ permissions: supportGrant.permissions })
        .from(supportGrant)
        .where(
          and(
            eq(supportGrant.id, support.grantId),
            eq(supportGrant.engineerEmail, session.user.email.toLowerCase()),
            isNull(supportGrant.revokedAt),
            lte(supportGrant.startsAt, now),
            gt(supportGrant.expiresAt, now),
          ),
        );
      if (!grant) throw new TRPCError({ code: "FORBIDDEN", message: "Support access has ended" });
      role = "support";
      permissions = new Set(SUPPORT_PERMISSIONS.filter((p) => grant.permissions.includes(p)));
      // Every look at tenant data is on the record (K-12).
      await recordAudit(tx, { ...actor, organizationId, action: "support.read", subjectType: "support_grant", subjectId: support.grantId, after: { path } });
    } else {
      const grants = await tx
        .select({ permission: memberPermission.permission })
        .from(memberPermission)
        .where(eq(memberPermission.userId, session.user.id));
      role = member!.role;
      permissions = effectivePermissions(
        role,
        grants.map((g) => g.permission),
      );
    }
    let scope: Promise<Scope> | undefined;
    let entitlements: Promise<ModuleKey[]> | undefined;
    const result = await next({
      ctx: {
        session,
        organizationId,
        role,
        permissions,
        tx,
        scope: () => (scope ??= loadScope(tx, session.user.id)),
        entitlements: () => (entitlements ??= loadEntitlements(tx)),
        audit: (note: AuditNote) => recordAudit(tx, { ...note, organizationId, ...actor }),
        publish: <T>(event: EventDef<T>, payload: T, options: { id?: string } = {}) =>
          enqueueEvent(tx, {
            organizationId,
            type: event.type,
            version: event.version,
            payload: event.schema.parse(payload),
            id: options.id,
          }),
        notify: (input: Notify) => notify(tx, organizationId, input),
        config: <T>(def: SettingDef<T>, at?: Date) => readSetting(tx, def, at).then((v) => v.value),
        requestApproval: async (def: ApprovalDef, input: Omit<RequestApproval, "requestedByUserId">) => {
          const request = await requestApproval(tx, organizationId, def, { ...input, requestedByUserId: session.user.id });
          await recordAudit(tx, {
            organizationId,
            ...actor,
            action: "approvals.request",
            subjectType: "approval",
            subjectId: request.id,
            after: { kind: def.key, subject: input.subjectRef, status: request.status, amount: input.amount?.toString() ?? null },
            reason: input.note || null,
          });
          return request;
        },
        enqueue: <T>(def: JobDef<T>, payload: T, options: Omit<EnqueueOptions, "createdByUserId"> = {}) =>
          enqueueJob(tx, organizationId, def, payload, { ...options, createdByUserId: session.user.id }),
      },
    });
    if (!result.ok) throw result.error;
    return result;
  });
  if (!support) return run;
  return run.catch((error: unknown) => {
    if (error instanceof TRPCError && (error.code === "FORBIDDEN" || error.code === "NOT_FOUND")) return refuse(error);
    throw error;
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
 * permission is required (K-03). A router several modules bring (Work Orders, which GIS
 * alone also gives at level basic) names them all and answers while ANY is licensed;
 * finer checks, such as `workLevel(entitlements)`, are the router's own.
 */
export function moduleProcedure(modules: ModuleKey | readonly [ModuleKey, ...ModuleKey[]], ...required: Permission[]) {
  const list: readonly ModuleKey[] = typeof modules === "string" ? [modules] : modules;
  return tenantProcedure.use(async ({ ctx, next }) => {
    const licensed = await ctx.entitlements();
    if (!list.some((m) => licensed.includes(m))) {
      const names = list.join(" or ");
      throw new TRPCError({ code: "NOT_FOUND", message: `${names} ${list.length > 1 ? "are" : "is"} not licensed for this organization` });
    }
    assertPermissions(ctx.permissions, required);
    return next({ ctx: { modules: list } });
  });
}

/**
 * The message of an error the caller can act on (FORBIDDEN, NOT_FOUND, …), or null for
 * internal errors, whose details must not reach the user. For apps calling in-process.
 */
export function clientErrorMessage(error: unknown): string | null {
  return error instanceof TRPCError && error.code !== "INTERNAL_SERVER_ERROR" ? error.message : null;
}
