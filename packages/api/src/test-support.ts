import type { TestDatabase } from "@flowless/db/testing";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { appRouter, createCaller } from "./root";
import type { Session } from "./trpc";

export interface Member {
  userId: string;
  organizationId: string;
  role: string;
}

/** A user with one membership, written straight to the auth schema as Better Auth would. */
export async function addMember(t: TestDatabase, organizationId: string, role: string): Promise<Member> {
  const userId = randomUUID();
  await t.admin.execute(sql`insert into auth.user (id, name, email) values (${userId}, ${role}, ${`${userId}@example.test`})`);
  await t.admin.execute(
    sql`insert into auth.member (organization_id, user_id, role, created_at) values (${organizationId}, ${userId}, ${role}, now())`,
  );
  return { userId, organizationId, role };
}

export const sessionOf = (m: Member, activeOrganizationId: string | null = m.organizationId): Session => ({
  user: { id: m.userId, name: m.role, email: `${m.userId}@example.test` },
  session: { id: `session-${m.userId}`, activeOrganizationId },
  member: { organizationId: m.organizationId, role: m.role },
});

/** The app router, called in-process as `m` through the RLS-bound app role. */
export const callerFor = (t: TestDatabase, m: Member) => createCaller({ db: t.app, session: sessionOf(m) });

/** Every procedure in the app router, as "router.procedure" paths (NF-02, NF-31). */
export function procedures(): { path: string; type: "query" | "mutation" | "subscription" }[] {
  const all = (appRouter as unknown as { _def: { procedures: Record<string, { _def: { type: "query" | "mutation" | "subscription" } }> } })._def
    .procedures;
  return Object.entries(all).map(([path, p]) => ({ path, type: p._def.type }));
}

/** Calls a procedure by its path. */
export function callPath(caller: ReturnType<typeof createCaller>, path: string, input?: unknown): Promise<unknown> {
  const fn = path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], caller) as (input?: unknown) => Promise<unknown>;
  return fn(input);
}
