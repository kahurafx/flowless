import { account, customer, servicePoint } from "@flowless/db/schema/accounts";
import type { Scope } from "@flowless/shared-types";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";

/*
 * Scope restrictions (K-03) for customers, accounts and service points. A service point is
 * placed by its scheme, zone, DMA and route; a limited member sees the ones inside their
 * areas and routes (their scope is already expanded to everything below). An account is
 * seen through its service points, and a customer through their accounts. What has no
 * service point (or no account) yet belongs to whoever created it, so a limited clerk can
 * finish an enquiry; everything else outside the scope is NOT_FOUND to them. The SQL forms
 * return undefined for an unrestricted member, so `and(...)` ignores them.
 */

export interface Viewer {
  userId: string;
  scope: Scope;
}

export interface Placement {
  schemeId: string | null;
  zoneId: string | null;
  dmaId: string | null;
  routeId: string | null;
}

/** Is this placement inside the scope? Pure; the SQL form below must agree. */
export function placementInScope(scope: Scope, place: Placement): boolean {
  if (scope.kind === "all") return true;
  const areas = [place.schemeId, place.zoneId, place.dmaId];
  return areas.some((id) => id !== null && scope.areaIds.has(id)) || (place.routeId !== null && scope.routeIds.has(place.routeId));
}

/** Service points inside the scope. */
export function servicePointInScope(scope: Scope): SQL | undefined {
  if (scope.kind === "all") return undefined;
  const areaIds = [...scope.areaIds];
  const routeIds = [...scope.routeIds];
  const parts: SQL[] = [];
  if (areaIds.length) parts.push(inArray(servicePoint.schemeId, areaIds), inArray(servicePoint.zoneId, areaIds), inArray(servicePoint.dmaId, areaIds));
  if (routeIds.length) parts.push(inArray(servicePoint.routeId, routeIds));
  return parts.length ? or(...parts) : sql`false`;
}

/** Accounts with a service point in scope, or none at all and made by the viewer. */
export function accountVisible(viewer: Viewer): SQL | undefined {
  if (viewer.scope.kind === "all") return undefined;
  return or(
    sql`exists (select 1 from ${servicePoint} where ${servicePoint.accountId} = ${account.id} and ${servicePointInScope(viewer.scope)})`,
    and(
      sql`not exists (select 1 from ${servicePoint} where ${servicePoint.accountId} = ${account.id})`,
      eq(account.createdByUserId, viewer.userId),
    ),
  );
}

/** Customers with a visible account, or none at all and made by the viewer. */
export function customerVisible(viewer: Viewer): SQL | undefined {
  if (viewer.scope.kind === "all") return undefined;
  return or(
    sql`exists (select 1 from ${account} where ${account.customerId} = ${customer.id} and ${accountVisible(viewer)})`,
    and(
      sql`not exists (select 1 from ${account} where ${account.customerId} = ${customer.id})`,
      eq(customer.createdByUserId, viewer.userId),
    ),
  );
}
