import * as authSchema from "@flowless/db/auth-schema";
import {
  LOCAL_USERNAME_PATTERN,
  normalizeOrganizationCode,
  ORGANIZATION_CODE_HEADER,
  parseRoles,
} from "@flowless/shared-types";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { organization } from "better-auth/plugins/organization";
import { twoFactor } from "better-auth/plugins/two-factor";
import { username } from "better-auth/plugins/username";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { ac, roles } from "./access";
import { enqueueEvent } from "@flowless/db";
import { auditIdentity, organizationIdForCode } from "./audit";
import { emailMayAdminister, membershipOf } from "./membership";

export type AuthDatabase = PostgresJsDatabase<typeof authSchema>;

/** One message for every sign-in failure, so responses never reveal which part was wrong. */
const INVALID_CREDENTIALS = "Organization code, username or password is incorrect";

const ONE_ORGANIZATION = "A user belongs to exactly one organization";

const SIGN_IN_PATHS = new Set(["/sign-in/email", "/sign-in/username"]);
/** Second steps that finish a sign-in for users with two-factor on. */
const TWO_FACTOR_SIGN_IN_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code", "/two-factor/verify-otp"]);

/** Identity changes audited for the signed-in user (K-06). */
const ACCOUNT_EVENTS: Record<string, string> = {
  "/two-factor/enable": "auth.two_factor_enable",
  "/two-factor/disable": "auth.two_factor_disable",
  "/change-password": "auth.password_change",
};

const identifierOf = (body: unknown) => {
  const b = (body ?? {}) as { email?: unknown; username?: unknown };
  return String(b.email ?? b.username ?? "").trim().toLowerCase() || null;
};

/** Member and invitation endpoints audited from the after hook (adds come from organization hooks). */
const MEMBER_PATHS = new Set([
  "/organization/remove-member",
  "/organization/update-member-role",
  "/organization/invite-member",
  "/organization/cancel-invitation",
]);

/** Initial settings Flowless passed as organization metadata when onboarding, if any. */
function initialSettings(metadata: unknown): Record<string, string> | undefined {
  const parsed = typeof metadata === "string" ? (JSON.parse(metadata) as unknown) : metadata;
  const settings = (parsed as { settings?: unknown } | null | undefined)?.settings;
  return settings && typeof settings === "object" ? (settings as Record<string, string>) : undefined;
}

type Returned = { id?: string; userId?: string; role?: string; email?: string; organizationId?: string; member?: Returned };

/**
 * Identity, sessions and organization membership (K-01, K-03, NF-05).
 * `db` must connect as a member of `flowless_auth`, the only role with access to
 * the `auth` schema; it has no access to any module schema.
 *
 * Tenancy rules (requirements §1):
 * - A user belongs to exactly one organization: enforced here and by a unique index on
 *   `auth.member.user_id`. Users cannot create organizations; Flowless onboards them.
 * - Sign-in names the organization by code (ORGANIZATION_CODE_HEADER). Owners and admins
 *   sign in with email; other staff with a username stored as "<code>.<name>".
 * - The session's active organization is the user's one membership, set when the session
 *   is created. It cannot be switched.
 *
 * Secret and base URL come from BETTER_AUTH_SECRET and BETTER_AUTH_URL.
 */
export function createAuth(db: AuthDatabase) {
  /** A member's role before an update, read in the before hook for the audit entry. */
  const previousRoles = new Map<string, string>();

  /** A refused sign-in, in the audit log of the organization the code names (if any). */
  const auditFailedSignIn = async (headers: Headers | undefined, code: string | null, identifier: string | null, reason: string) => {
    const organizationId = code ? await organizationIdForCode(db, code) : null;
    if (!organizationId) return;
    await auditIdentity(db, headers, { organizationId, action: "auth.sign_in_failed", actorLabel: identifier, reason });
  };

  return betterAuth({
    appName: "Flowless",
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema, schemaName: "auth" }),
    // UUIDs because tenant RLS policies compare organization_id as uuid.
    advanced: { database: { generateId: "uuid" } },
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    // Brute-force protection (NF-05), on in every environment, stricter on sign-in.
    // In-memory per instance for now; move to shared storage when web scales out.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-in/username": { window: 60, max: 5 },
        "/two-factor/*": { window: 60, max: 5 },
      },
    },
    // The active organization is the user's only membership; nothing may change it.
    disabledPaths: ["/organization/set-active"],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/organization/update-member-role") {
          const memberId = String(ctx.body?.memberId ?? "");
          const [row] = await db.select({ role: authSchema.member.role }).from(authSchema.member).where(eq(authSchema.member.id, memberId));
          if (row) previousRoles.set(memberId, row.role);
          return;
        }
        if (!SIGN_IN_PATHS.has(ctx.path)) return;
        const code = normalizeOrganizationCode(ctx.headers?.get(ORGANIZATION_CODE_HEADER) ?? "");
        if (!code) throw new APIError("BAD_REQUEST", { message: "Organization code is required" });

        const allowed =
          ctx.path === "/sign-in/email"
            ? await emailMayAdminister(db, code, String(ctx.body?.email ?? ""))
            : String(ctx.body?.username ?? "").toLowerCase().startsWith(`${code}.`);
        if (!allowed) {
          const reason = ctx.path === "/sign-in/email" ? "Not an administrator of this organization" : "Username not in this organization";
          await auditFailedSignIn(ctx.headers, code, identifierOf(ctx.body), reason);
          throw new APIError("UNAUTHORIZED", { message: INVALID_CREDENTIALS });
        }
      }),
      // Audit (K-06). Runs after every endpoint, including ones that answered with an error.
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        const failed = isAPIError(returned);
        const headers = ctx.headers;

        if (SIGN_IN_PATHS.has(ctx.path) || TWO_FACTOR_SIGN_IN_PATHS.has(ctx.path)) {
          if (failed) {
            if (SIGN_IN_PATHS.has(ctx.path)) {
              const code = normalizeOrganizationCode(headers?.get(ORGANIZATION_CODE_HEADER) ?? "");
              await auditFailedSignIn(headers, code, identifierOf(ctx.body), "Wrong password");
            }
            return;
          }
          const session = ctx.context.newSession;
          const membership = session && (await membershipOf(db, session.user.id));
          if (!session || !membership) return; // e.g. a password accepted, second factor still to come
          await auditIdentity(db, headers, {
            organizationId: membership.organizationId,
            action: "auth.sign_in",
            actorUserId: session.user.id,
            actorLabel: session.user.name,
            after: { method: ctx.path.replace(/^\//, "") },
          });
          return;
        }
        if (failed || !returned || !(ctx.path in ACCOUNT_EVENTS || MEMBER_PATHS.has(ctx.path))) return;

        // After hooks do not carry the endpoint's session; read it from the request.
        const actor = (ctx.context.session ?? (await getSessionFromCtx(ctx)))?.user ?? null;
        const data = returned as Returned;

        const accountEvent = ACCOUNT_EVENTS[ctx.path];
        if (accountEvent && actor) {
          const membership = await membershipOf(db, actor.id);
          if (membership) {
            await auditIdentity(db, headers, {
              organizationId: membership.organizationId,
              action: accountEvent,
              actorUserId: actor.id,
              actorLabel: actor.name,
              subjectType: "user",
              subjectId: actor.id,
            });
          }
          return;
        }

        const by = { actorUserId: actor?.id ?? null, actorLabel: actor?.name ?? "Flowless" };
        switch (ctx.path) {
          case "/organization/remove-member": {
            const member = data.member;
            if (member?.organizationId) {
              await auditIdentity(db, headers, {
                ...by,
                organizationId: member.organizationId,
                action: "member.remove",
                subjectType: "member",
                subjectId: member.userId ?? null,
                before: { role: member.role },
              });
            }
            return;
          }
          case "/organization/update-member-role": {
            const memberId = String(ctx.body?.memberId ?? "");
            const previous = previousRoles.get(memberId);
            previousRoles.delete(memberId);
            if (data.organizationId) {
              await auditIdentity(db, headers, {
                ...by,
                organizationId: data.organizationId,
                action: "member.change_role",
                subjectType: "member",
                subjectId: data.userId ?? null,
                before: { role: previous ?? null },
                after: { role: data.role },
              });
            }
            return;
          }
          case "/organization/invite-member":
          case "/organization/cancel-invitation":
            if (data.organizationId) {
              await auditIdentity(db, headers, {
                ...by,
                organizationId: data.organizationId,
                action: ctx.path === "/organization/invite-member" ? "invitation.create" : "invitation.cancel",
                subjectType: "invitation",
                subjectId: data.id ?? null,
                after: { email: data.email, role: data.role },
              });
            }
            return;
        }
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const membership = await membershipOf(db, session.userId);
            return { data: { ...session, activeOrganizationId: membership?.organizationId ?? null } };
          },
        },
      },
    },
    plugins: [
      organization({
        ac,
        roles,
        allowUserToCreateOrganization: false,
        organizationLimit: 1,
        organizationHooks: {
          beforeAddMember: async ({ member }) => {
            // Better Auth checks role names on invitations and role changes, but not when
            // a member is added server-side; an unknown role would hold no permissions.
            if (parseRoles(member.role).length !== member.role.split(",").length) {
              throw new APIError("BAD_REQUEST", { message: `Unknown role: ${member.role}` });
            }
            if (await membershipOf(db, member.userId)) throw new APIError("BAD_REQUEST", { message: ONE_ORGANIZATION });
          },
          beforeAcceptInvitation: async ({ user }) => {
            if (await membershipOf(db, user.id)) throw new APIError("BAD_REQUEST", { message: ONE_ORGANIZATION });
          },
          // Server-side calls (onboarding, adding staff) have no request, so these are system
          // actions; invitations are accepted by the person joining.
          afterCreateOrganization: async ({ organization: org, user }) => {
            // Lifecycle event (K-09): kernel consumers set the organization up (settings first).
            // The organization id doubles as the event id, so it is published once.
            await enqueueEvent(db, {
              id: org.id,
              organizationId: org.id,
              type: "organization.created",
              payload: { name: org.name, code: org.slug, settings: initialSettings(org.metadata) },
            });
            await auditIdentity(db, undefined, {
              organizationId: org.id,
              action: "organization.create",
              actorLabel: "Flowless",
              subjectType: "organization",
              subjectId: org.id,
              after: { name: org.name, code: org.slug, owner: user.email },
            });
          },
          afterAddMember: async ({ member, organization: org }) => {
            await auditIdentity(db, undefined, {
              organizationId: org.id,
              action: "member.add",
              actorLabel: "Flowless",
              subjectType: "member",
              subjectId: member.userId,
              after: { role: member.role },
            });
          },
          afterAcceptInvitation: async ({ member, user, organization: org }) => {
            await auditIdentity(db, undefined, {
              organizationId: org.id,
              action: "member.add",
              actorUserId: user.id,
              actorLabel: user.name,
              subjectType: "member",
              subjectId: member.userId,
              after: { role: member.role, via: "invitation" },
            });
          },
        },
      }),
      twoFactor(),
      username({
        maxUsernameLength: 65,
        // "<organization code>.<local name>", both lowercase (see qualifiedUsername).
        usernameValidator: (value) => {
          const dot = value.indexOf(".");
          return (
            dot > 0 &&
            normalizeOrganizationCode(value.slice(0, dot)) === value.slice(0, dot) &&
            LOCAL_USERNAME_PATTERN.test(value.slice(dot + 1))
          );
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** The full Better Auth session (user + session, with plugin fields). */
export type AuthSession = Auth["$Infer"]["Session"];
