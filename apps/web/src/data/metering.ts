import { READING_OUTCOMES, READING_STATUSES, METER_KINDS, METER_STATUSES, type MeterKind, type MeterStatus, type ReadingOutcome } from "@flowless/shared-types";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { accountLabels, type AccountLabel } from "./account-labels";
import { orNull } from "./accounts";
import { getHierarchy } from "./hierarchy";
import { listPeople, nameOf } from "./people";
import { getApi, requireModule } from "./session";

type Api = Awaited<ReturnType<typeof getApi>>["api"];
export type MeterRow = Awaited<ReturnType<Api["metering"]["meters"]["list"]>>["meters"][number];
export type ReadingRow = Awaited<ReturnType<Api["metering"]["readings"]["list"]>>[number];
export type VisitRow = Awaited<ReturnType<Api["metering"]["attempts"]["list"]>>[number];
export type HandoverRow = Awaited<ReturnType<Api["metering"]["handovers"]["list"]>>[number];
export type RoundTask = Awaited<ReturnType<Api["metering"]["snapshots"]["tasks"]>>[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const READINGS_PAGE = 50;
export const METERS_PAGE = 50;

/** Metering licensed and the member holds the permission (meters:read by default); else the page is not found. */
export const requireMetering = (permission: "meters:read" | "readings:read" = "meters:read") => requireModule("metering", permission);

const one = <T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined => allowed.find((a) => a === value);

async function meterSerials(ids: readonly string[]): Promise<Record<string, string>> {
  const { api } = await getApi();
  const found = await Promise.all([...new Set(ids)].map(async (id) => [id, (await orNull(api.metering.meters.get({ meterId: id })))?.meter.serial] as const));
  return Object.fromEntries(found.flatMap(([id, serial]) => (serial ? [[id, serial]] : [])));
}

const labelsObject = (m: Map<string, AccountLabel>) => Object.fromEntries(m);

/** The meter register, by serial (M-01, M-12). */
export async function listMeters(params: { status?: string | undefined; kind?: string | undefined; q?: string | undefined; after?: string | undefined }) {
  await connection();
  const session = await requireMetering("meters:read");
  const { api } = await getApi();
  const status = one<MeterStatus>(params.status, METER_STATUSES);
  const kind = one<MeterKind>(params.kind, METER_KINDS);
  const [page, hierarchy] = await Promise.all([
    api.metering.meters.list({ limit: METERS_PAGE, ...(status ? { status } : {}), ...(kind ? { kind } : {}), ...(params.q ? { search: params.q } : {}), ...(params.after ? { after: params.after } : {}) }),
    getHierarchy(),
  ]);
  return {
    meters: page.meters,
    next: page.next,
    canManage: session.access.permissions.includes("meters:manage"),
    dmas: hierarchy.areas.filter((a) => a.level === "dma" && !a.archivedAt).map((a) => ({ value: a.id, label: a.name })),
    dmaName: (id: string | null) => (id ? (hierarchy.areas.find((a) => a.id === id)?.name ?? null) : null),
  };
}

/** One meter: its status and log, the open installation, installation history and recent readings. */
export async function getMeterPage(id: string) {
  await connection();
  const session = await requireMetering("meters:read");
  if (!UUID.test(id)) notFound();
  const { api } = await getApi();
  const detail = await orNull(api.metering.meters.get({ meterId: id }));
  if (!detail) notFound();
  const canRead = session.access.permissions.includes("readings:read");
  const [installations, readings, people] = await Promise.all([
    api.metering.installations.list({ meterId: id, limit: 20 }),
    canRead ? api.metering.readings.list({ meterId: id, limit: 20 }) : Promise.resolve([]),
    listPeople(),
  ]);
  const labels = await accountLabels(readings.flatMap((r) => (r.accountId ? [r.accountId] : [])));
  return {
    ...detail,
    installations,
    readings,
    labels: labelsObject(labels),
    actors: Object.fromEntries(detail.events.map((e) => [e.id, nameOf(people, e.actorUserId) ?? "The system"])),
    canManage: session.access.permissions.includes("meters:manage"),
    canRead,
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
  };
}
export type MeterPage = Awaited<ReturnType<typeof getMeterPage>>;

/** Readings with their validation flags (M-02, M-05); `needsReview` is the queue of flagged ones. */
export async function listReadings(params: { review?: string | undefined; status?: string | undefined; meterId?: string | undefined; before?: string | undefined }) {
  await connection();
  const session = await requireMetering("readings:read");
  const { api } = await getApi();
  const status = one<(typeof READING_STATUSES)[number]>(params.status, READING_STATUSES);
  const before = params.before ? new Date(params.before) : null;
  const rows = await api.metering.readings.list({
    limit: READINGS_PAGE,
    ...(params.review === "1" ? { needsReview: true } : {}),
    ...(status ? { status } : {}),
    ...(params.meterId && UUID.test(params.meterId) ? { meterId: params.meterId } : {}),
    ...(before && !Number.isNaN(before.getTime()) ? { before } : {}),
  });
  const [labels, serials, people] = await Promise.all([accountLabels(rows.flatMap((r) => (r.accountId ? [r.accountId] : []))), meterSerials(rows.map((r) => r.meterId)), listPeople()]);
  return {
    rows,
    labels: labelsObject(labels),
    serials,
    readers: Object.fromEntries(rows.map((r) => [r.id, nameOf(people, r.readerUserId) ?? ""])),
    next: rows.length === READINGS_PAGE ? rows[rows.length - 1]!.readAt.toISOString() : null,
    canApprove: session.access.permissions.includes("readings:approve"),
    canCapture: session.access.permissions.includes("readings:capture"),
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
  };
}

/** Visits (attempts) to read a service point, with the outcome and the disposition billing applies (M-06). */
export async function listVisits(params: { outcome?: string | undefined; cycleDate?: string | undefined }) {
  await connection();
  const session = await requireMetering("readings:read");
  const { api } = await getApi();
  const outcome = one<ReadingOutcome>(params.outcome, READING_OUTCOMES);
  const rows = await api.metering.attempts.list({ limit: 100, ...(outcome ? { outcome } : {}), ...(params.cycleDate && /^\d{4}-\d{2}-\d{2}$/.test(params.cycleDate) ? { cycleDate: params.cycleDate } : {}) });
  const [labels, people] = await Promise.all([accountLabels(rows.flatMap((r) => (r.accountId ? [r.accountId] : []))), listPeople()]);
  return {
    rows,
    labels: labelsObject(labels),
    readers: Object.fromEntries(rows.map((r) => [r.id, nameOf(people, r.readerUserId) ?? ""])),
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
  };
}

/** Eligibility snapshots by route and cycle date (M-08). */
export async function listRounds(params: { routeId?: string | undefined }) {
  await connection();
  const session = await requireMetering("readings:read");
  const { api } = await getApi();
  const [snapshots, hierarchy] = await Promise.all([api.metering.snapshots.list({ limit: 100, ...(params.routeId && UUID.test(params.routeId) ? { routeId: params.routeId } : {}) }), getHierarchy()]);
  const routes = hierarchy.routes.filter((r) => !r.archivedAt);
  return {
    snapshots: snapshots.map((s) => ({ ...s, routeName: hierarchy.routes.find((r) => r.id === s.routeId)?.name ?? s.routeId.slice(0, 8) })),
    routes: routes.map((r) => ({ id: r.id, name: r.name })),
    canTake: session.access.permissions.includes("meters:manage"),
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
  };
}

/** One snapshot: every row with why it is or is not eligible, and the reading tasks derived from the eligible ones. */
export async function getRound(id: string) {
  await connection();
  const session = await requireMetering("readings:read");
  if (!UUID.test(id)) notFound();
  const { api } = await getApi();
  const snapshot = await orNull(api.metering.snapshots.get({ snapshotId: id }));
  if (!snapshot) notFound();
  const [tasks, hierarchy, labels, people] = await Promise.all([
    api.metering.snapshots.tasks({ snapshotId: id }),
    getHierarchy(),
    accountLabels(snapshot.rows.map((r) => r.accountId)),
    listPeople(),
  ]);
  const meters = await meterSerials(snapshot.rows.flatMap((r) => (r.meterId ? [r.meterId] : [])));
  return {
    snapshot,
    tasks: Object.fromEntries(tasks.map((t) => [t.servicePointId, { state: t.state, outcome: t.lastAttempt?.outcome ?? null, disposition: t.lastAttempt?.disposition ?? null }])),
    routeName: hierarchy.routes.find((r) => r.id === snapshot.routeId)?.name ?? snapshot.routeId.slice(0, 8),
    labels: labelsObject(labels),
    meters,
    takenBy: nameOf(people, snapshot.takenByUserId) ?? "The system",
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
  };
}
export type RoundPage = Awaited<ReturnType<typeof getRound>>;

/** Reading handovers owed when an account changes hands or holder (C-08, C-10). */
export async function listHandovers(params: { pending?: string | undefined }) {
  await connection();
  const session = await requireMetering("readings:read");
  const { api } = await getApi();
  const rows = await api.metering.handovers.list({ limit: 100, ...(params.pending === "1" ? { pending: true } : {}) });
  const [labels, serials] = await Promise.all([accountLabels(rows.flatMap((r) => [r.fromAccountId, r.toAccountId])), meterSerials(rows.map((r) => r.meterId))]);
  return {
    rows,
    labels: labelsObject(labels),
    serials,
    canLink: session.access.permissions.includes("readings:approve"),
  };
}
