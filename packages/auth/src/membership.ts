import * as authSchema from "@flowless/db/auth-schema";
import { ADMIN_ROLES, parseRoles } from "@flowless/shared-types";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

type Db = PostgresJsDatabase<typeof authSchema>;
const { member, organization, user } = authSchema;

/** The user's one membership, if any. */
export async function membershipOf(db: Db, userId: string) {
  const [row] = await db
    .select({ organizationId: member.organizationId, role: member.role })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);
  return row ?? null;
}

/** True when `email` belongs to an owner or admin of the organization with `code`. */
export async function emailMayAdminister(db: Db, code: string, email: string): Promise<boolean> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(organization.slug, code), eq(sql`lower(${user.email})`, email.trim().toLowerCase())))
    .limit(1);
  return !!row && parseRoles(row.role).some((role) => ADMIN_ROLES.includes(role));
}
