import type { Transaction } from "@flowless/db";
import { servicePoint } from "@flowless/db/schema/accounts";
import { SERVICE_POINT_STATUSES } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { EventDef } from "../../kernel/events";
import { tidy } from "../../kernel/text";
import type { AuditNote } from "../../trpc";
import { descendantsOf } from "../../kernel/scope";
import { router } from "../../trpc";
import { servicePointInScope, type Placement, type Viewer } from "./access";
import { servicePointCreated } from "./events";
import type { AccountsProcedures } from "./procedures";
import { assertPlacementInScope, findAccount, findServicePoint, toServicePointDto, validatePlacement } from "./service";

const Address = z.string().trim().min(1).max(300);
const Location = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

/** What the audit log keeps of a service point. */
const audited = (s: ReturnType<typeof toServicePointDto>) => ({
  accountId: s.accountId,
  address: s.address,
  location: s.location,
  schemeId: s.schemeId,
  zoneId: s.zoneId,
  dmaId: s.dmaId,
  routeId: s.routeId,
  connectionStatus: s.connectionStatus,
  gisConnectionId: s.gisConnectionId,
});

export interface ServicePointEnv {
  tx: Transaction;
  organizationId: string;
  userId: string;
  audit(note: AuditNote): Promise<void>;
  publish<T>(event: EventDef<T>, payload: T): Promise<unknown>;
}

export interface NewServicePoint {
  accountId: string;
  address: string;
  location?: { lat: number; lng: number } | null | undefined;
  schemeId?: string | null | undefined;
  zoneId?: string | null | undefined;
  dmaId?: string | null | undefined;
  routeId?: string | null | undefined;
  connectionStatus?: (typeof SERVICE_POINT_STATUSES)[number] | undefined;
  gisConnectionId?: string | null | undefined;
}

/**
 * Creates a service point on an account the viewer can see, with its place checked against
 * the kernel hierarchy and the viewer's scope. Shared by `servicePoints.create`, converting
 * an application and completing a relocation.
 */
export async function createServicePoint(env: ServicePointEnv, viewer: Viewer, input: NewServicePoint) {
  await findAccount(env.tx, viewer, { id: input.accountId });
  const place: Placement = { schemeId: input.schemeId ?? null, zoneId: input.zoneId ?? null, dmaId: input.dmaId ?? null, routeId: input.routeId ?? null };
  await validatePlacement(env.tx, place, new Set(["schemeId", "zoneId", "dmaId", "routeId"]));
  assertPlacementInScope(viewer, place);
  const [row] = await env.tx
    .insert(servicePoint)
    .values({
      organizationId: env.organizationId,
      accountId: input.accountId,
      address: tidy(input.address),
      location: input.location ?? null,
      ...place,
      connectionStatus: input.connectionStatus ?? "PLANNED",
      gisConnectionId: input.gisConnectionId ?? null,
      createdByUserId: env.userId,
    })
    .returning();
  const dto = toServicePointDto(row!);
  await env.audit({ action: "accounts.service_point_create", subjectType: "service_point", subjectId: row!.id, after: audited(dto) });
  await env.publish(servicePointCreated, {
    servicePointId: row!.id,
    accountId: row!.accountId,
    ...place,
    location: dto.location,
    connectionStatus: row!.connectionStatus,
    gisConnectionId: row!.gisConnectionId,
    createdByUserId: env.userId,
  });
  return dto;
}

/**
 * Service points (glossary, C-12 inputs): the physical connection of an account, with its
 * GPS point, the kernel scheme, zone, DMA and route, and a connection status. The hierarchy
 * references are checked through the kernel's published reads (K-02). A limited member
 * (K-03) only sees and places service points inside their scope.
 */
export function servicePointsRouter(p: AccountsProcedures) {
  return router({
    create: p.create
      .input(
        z.object({
          accountId: z.uuid(),
          address: Address,
          location: Location.optional(),
          schemeId: z.uuid().optional(),
          zoneId: z.uuid().optional(),
          dmaId: z.uuid().optional(),
          routeId: z.uuid().optional(),
          connectionStatus: z.enum(SERVICE_POINT_STATUSES).default("PLANNED"),
          /** GIS's service connection for this point, by id (not checked: GIS and Accounts never read each other's tables). */
          gisConnectionId: z.uuid().optional(),
        }),
      )
      .mutation(({ ctx, input }) => createServicePoint({ ...ctx, userId: ctx.viewer.userId }, ctx.viewer, input)),

    /** Null clears a place, GPS point or GIS link. The account cannot change here: that is succession or relocation (C-08, C-10). */
    update: p.update
      .input(
        z.object({
          id: z.uuid(),
          patch: z
            .object({
              address: Address,
              location: Location.nullable(),
              schemeId: z.uuid().nullable(),
              zoneId: z.uuid().nullable(),
              dmaId: z.uuid().nullable(),
              routeId: z.uuid().nullable(),
              connectionStatus: z.enum(SERVICE_POINT_STATUSES),
              gisConnectionId: z.uuid().nullable(),
            })
            .partial()
            .refine((patch) => Object.values(patch).some((v) => v !== undefined), "Patch is empty"),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const before = await findServicePoint(ctx.tx, ctx.viewer, input.id);
        await ctx.tx.select({ id: servicePoint.id }).from(servicePoint).where(eq(servicePoint.id, before.id)).for("update");
        const { patch } = input;
        const place: Placement = {
          schemeId: patch.schemeId !== undefined ? patch.schemeId : before.schemeId,
          zoneId: patch.zoneId !== undefined ? patch.zoneId : before.zoneId,
          dmaId: patch.dmaId !== undefined ? patch.dmaId : before.dmaId,
          routeId: patch.routeId !== undefined ? patch.routeId : before.routeId,
        };
        const changed = new Set((Object.keys(place) as (keyof Placement)[]).filter((k) => place[k] !== before[k]));
        if (changed.size) {
          await validatePlacement(ctx.tx, place, changed);
          assertPlacementInScope(ctx.viewer, place);
        }
        const next = {
          address: patch.address !== undefined ? tidy(patch.address) : before.address,
          location: patch.location !== undefined ? patch.location : before.location,
          ...place,
          connectionStatus: patch.connectionStatus ?? before.connectionStatus,
          gisConnectionId: patch.gisConnectionId !== undefined ? patch.gisConnectionId : before.gisConnectionId,
        };
        const was = audited(toServicePointDto(before));
        if (JSON.stringify(was) === JSON.stringify({ accountId: before.accountId, ...next })) return toServicePointDto(before);
        const [row] = await ctx.tx.update(servicePoint).set({ ...next, updatedAt: new Date() }).where(eq(servicePoint.id, before.id)).returning();
        const dto = toServicePointDto(row!);
        await ctx.audit({ action: "accounts.service_point_update", subjectType: "service_point", subjectId: before.id, before: was, after: audited(dto) });
        return dto;
      }),

    get: p.read.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => toServicePointDto(await findServicePoint(ctx.tx, ctx.viewer, input.id))),

    /** Oldest first; pass the last id of a page as `after` for the next one. */
    list: p.read
      .input(
        z
          .object({
            accountId: z.uuid().optional(),
            /** In this area (scheme, zone, sub-zone or DMA) or below it. */
            areaId: z.uuid().optional(),
            /** On this route or below it. */
            routeId: z.uuid().optional(),
            connectionStatus: z.enum(SERVICE_POINT_STATUSES).optional(),
            after: z.uuid().optional(),
            limit: z.number().int().min(1).max(200).default(50),
          })
          .optional(),
      )
      .query(async ({ ctx, input }) => {
        let cursor;
        if (input?.after) {
          const [row] = await ctx.tx
            .select({ id: servicePoint.id })
            .from(servicePoint)
            .where(and(eq(servicePoint.id, input.after), servicePointInScope(ctx.viewer.scope)));
          if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Service point not found" });
          cursor = sql`(${servicePoint.createdAt}, ${servicePoint.id}) > (select s.created_at, s.id from accounts.service_point s where s.id = ${row.id}::uuid)`;
        }
        const areaIds = input?.areaId ? [...(await descendantsOf(ctx.tx, "area", input.areaId))] : null;
        const routeIds = input?.routeId ? [...(await descendantsOf(ctx.tx, "route", input.routeId))] : null;
        const rows = await ctx.tx
          .select()
          .from(servicePoint)
          .where(
            and(
              servicePointInScope(ctx.viewer.scope),
              input?.accountId ? eq(servicePoint.accountId, input.accountId) : undefined,
              areaIds ? or(inArray(servicePoint.schemeId, areaIds), inArray(servicePoint.zoneId, areaIds), inArray(servicePoint.dmaId, areaIds)) : undefined,
              routeIds ? inArray(servicePoint.routeId, routeIds) : undefined,
              input?.connectionStatus ? eq(servicePoint.connectionStatus, input.connectionStatus) : undefined,
              cursor,
            ),
          )
          .orderBy(asc(servicePoint.createdAt), asc(servicePoint.id))
          .limit(input?.limit ?? 50);
        return rows.map(toServicePointDto);
      }),
  });
}
