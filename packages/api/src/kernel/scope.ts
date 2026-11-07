import type { Transaction } from "@flowless/db";
import type { Scope } from "@flowless/shared-types";
import { sql } from "drizzle-orm";

/**
 * A member's scope (K-03): unrestricted without scope rows; otherwise the areas and
 * routes they were limited to, each expanded to everything below it. Runs under RLS, so
 * only this organization's trees are walked. Archived areas still count: archiving
 * hides an area from new work, not from people who look after its history.
 */
export async function loadScope(tx: Transaction, userId: string): Promise<Scope> {
  const [areas, routes] = await Promise.all([
    tx.execute<{ id: string }>(sql`
      with recursive covered as (
        select area_id as id from kernel.member_area_scope where user_id = ${userId}
        union
        select child.id from kernel.area child join covered on child.parent_id = covered.id
      ) select id from covered`),
    tx.execute<{ id: string }>(sql`
      with recursive covered as (
        select route_id as id from kernel.member_route_scope where user_id = ${userId}
        union
        select child.id from kernel.route child join covered on child.parent_id = covered.id
      ) select id from covered`),
  ]);
  if (areas.length === 0 && routes.length === 0) return { kind: "all" };
  return { kind: "limited", areaIds: new Set(areas.map((r) => r.id)), routeIds: new Set(routes.map((r) => r.id)) };
}

/** Ids of `rootId` and everything below it in `table` ("area" or "route"). */
export async function descendantsOf(tx: Transaction, table: "area" | "route", rootId: string): Promise<Set<string>> {
  const rows = await tx.execute<{ id: string }>(sql`
    with recursive below as (
      select id from ${sql.raw(`kernel.${table}`)} where id = ${rootId}
      union
      select child.id from ${sql.raw(`kernel.${table}`)} child join below on child.parent_id = below.id
    ) select id from below`);
  return new Set(rows.map((r) => r.id));
}
