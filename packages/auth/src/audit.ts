import * as authSchema from "@flowless/db/auth-schema";
import { recordAudit, type AuditEntry, type AuditSource } from "@flowless/db";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

type Db = PostgresJsDatabase<typeof authSchema>;

/**
 * Clients name themselves in `x-flowless-client`; other requests are direct API calls.
 * Server-side calls without request headers (onboarding, seeds) are system actions.
 */
export function sourceOf(headers: Headers | undefined): AuditSource {
  if (!headers) return "system";
  const client = headers.get("x-flowless-client");
  return client === "web" || client === "mobile" ? client : "api";
}

/** The caller's address as the proxy reports it. */
export function ipOf(headers: Headers | undefined): string | null {
  return headers?.get("x-forwarded-for")?.split(",")[0]?.trim() || headers?.get("x-real-ip") || null;
}

export async function organizationIdForCode(db: Db, code: string): Promise<string | null> {
  const [row] = await db
    .select({ id: authSchema.organization.id })
    .from(authSchema.organization)
    .where(eq(authSchema.organization.slug, code))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Records an identity event in the tenant's audit log (K-06). The auth role may insert
 * there and nothing else (`0009_kernel_audit_append_only.sql`).
 */
export function auditIdentity(db: Db, headers: Headers | undefined, entry: Omit<AuditEntry, "source" | "ipAddress">) {
  return recordAudit(db, { ...entry, source: sourceOf(headers), ipAddress: ipOf(headers) });
}
