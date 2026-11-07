import * as authSchema from "@flowless/db/auth-schema";
import {
  LOCAL_USERNAME_PATTERN,
  normalizeOrganizationCode,
  ORGANIZATION_CODE_HEADER,
  parseRoles,
} from "@flowless/shared-types";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins/organization";
import { twoFactor } from "better-auth/plugins/two-factor";
import { username } from "better-auth/plugins/username";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { ac, roles } from "./access";
import { emailMayAdminister, membershipOf } from "./membership";

export type AuthDatabase = PostgresJsDatabase<typeof authSchema>;

/** One message for every sign-in failure, so responses never reveal which part was wrong. */
const INVALID_CREDENTIALS = "Organization code, username or password is incorrect";

const ONE_ORGANIZATION = "A user belongs to exactly one organization";

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
        if (ctx.path !== "/sign-in/email" && ctx.path !== "/sign-in/username") return;
        const code = normalizeOrganizationCode(ctx.headers?.get(ORGANIZATION_CODE_HEADER) ?? "");
        if (!code) throw new APIError("BAD_REQUEST", { message: "Organization code is required" });

        const allowed =
          ctx.path === "/sign-in/email"
            ? await emailMayAdminister(db, code, String(ctx.body?.email ?? ""))
            : String(ctx.body?.username ?? "").toLowerCase().startsWith(`${code}.`);
        if (!allowed) throw new APIError("UNAUTHORIZED", { message: INVALID_CREDENTIALS });
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
