import type { CommercialStatus, ServiceState } from "@flowless/shared-types";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { getHierarchy } from "./hierarchy";
import { listPeople, nameOf } from "./people";
import { getApi, requireModule, type Session } from "./session";

type Api = Awaited<ReturnType<typeof getApi>>["api"];
export type AccountRow = Awaited<ReturnType<Api["accounts"]["list"]>>[number];
export type AccountDetail = Awaited<ReturnType<Api["accounts"]["get"]>>;
export type CustomerDetail = Awaited<ReturnType<Api["accounts"]["customers"]["get"]>>;
export type CommandRow = Awaited<ReturnType<Api["accounts"]["commands"]["list"]>>[number];
export type ActivationStatus = Awaited<ReturnType<Api["accounts"]["activation"]["status"]>>;
export type HolderPeriod = Awaited<ReturnType<Api["accounts"]["holders"]["list"]>>[number];
export type RelocationRow = Awaited<ReturnType<Api["accounts"]["relocations"]["list"]>>[number];
export type MembershipClass = Awaited<ReturnType<Api["accounts"]["memberships"]["classes"]>>[number];

export const PAGE_SIZE = 50;

/** The answer when a procedure says NOT_FOUND (a hidden or missing record), otherwise the error. */
export async function orNull<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

/** Accounts is licensed and the member may read it; anything else is not found. */
export const requireAccounts = () => requireModule("accounts", "accounts:read");

/**
 * Category names by id. Categories belong to Tariffs: with Tariffs unlicensed (or no
 * `tariffs:read`) there are none to name and the screens show no category column (T-02).
 */
export const getCategories = cache(async (): Promise<{ licensed: boolean; categories: { id: string; name: string; active: boolean }[] }> => {
  const { organization, access } = await requireAccounts();
  if (!organization.entitlements.includes("tariffs") || !access.permissions.includes("tariffs:read")) return { licensed: false, categories: [] };
  const { api } = await getApi();
  const categories = await api.tariffs.categories.list({ includeInactive: true });
  return { licensed: true, categories: categories.map((c) => ({ id: c.id, name: c.name, active: c.active })) };
});

/** Area and route names by id, for labels on lists and detail pages. */
export const getPlaceNames = cache(async () => {
  const { areas, routes } = await getHierarchy();
  const area = new Map(areas.map((a) => [a.id, a.name]));
  const route = new Map(routes.map((r) => [r.id, r.name]));
  return {
    area: (id: string | null) => (id ? (area.get(id) ?? null) : null),
    route: (id: string | null) => (id ? (route.get(id) ?? null) : null),
    areas: areas.filter((a) => !a.archivedAt),
    routes: routes.filter((r) => !r.archivedAt),
  };
});

export interface AccountListParams {
  q?: string | undefined;
  commercialStatus?: CommercialStatus | undefined;
  serviceStatus?: ServiceState | undefined;
  areaId?: string | undefined;
  routeId?: string | undefined;
  after?: string | undefined;
}

export interface AccountListRow extends AccountRow {
  categoryName: string | null;
}

/**
 * The accounts list (C-02): a search by number, customer name or phone, or the filtered list
 * in number order with keyset paging. A search returns its best matches (no paging) and the
 * status filters are applied to them here. A scope-limited member sees only what the API returns.
 */
export async function listAccounts(params: AccountListParams = {}) {
  const session = await requireAccounts();
  const { api } = await getApi();
  const [categories, places] = await Promise.all([getCategories(), getPlaceNames()]);
  const q = params.q?.trim();

  let rows: AccountRow[];
  let nextCursor: string | null = null;
  if (q) {
    rows = (await api.accounts.search({ q, limit: 100 })).filter(
      (a) =>
        (!params.commercialStatus || a.commercialStatus === params.commercialStatus) &&
        (!params.serviceStatus || a.serviceStatus === params.serviceStatus),
    );
  } else {
    const page = await api.accounts.list({
      ...(params.commercialStatus ? { commercialStatus: params.commercialStatus } : {}),
      ...(params.serviceStatus ? { serviceStatus: params.serviceStatus } : {}),
      ...(params.areaId ? { areaId: params.areaId } : {}),
      ...(params.routeId ? { routeId: params.routeId } : {}),
      ...(params.after ? { after: params.after } : {}),
      limit: PAGE_SIZE + 1,
    });
    rows = page.slice(0, PAGE_SIZE);
    if (page.length > PAGE_SIZE) nextCursor = rows.at(-1)?.number ?? null;
  }
  const names = new Map(categories.categories.map((c) => [c.id, c.name]));
  return {
    rows: rows.map((a): AccountListRow => ({ ...a, categoryName: a.categoryId ? (names.get(a.categoryId) ?? "Unknown category") : null })),
    nextCursor,
    searched: Boolean(q),
    showCategory: categories.licensed,
    areas: places.areas.map(({ id, name, level }) => ({ id, name, level })),
    routes: places.routes.map(({ id, name, code }) => ({ id, name: `${code} · ${name}` })),
    canCreate: session.access.permissions.includes("accounts:create"),
    locale: session.organization.settings.locale,
  };
}

/** The best few matches for the command palette. */
export async function findAccounts(q: string) {
  await requireAccounts();
  const { api } = await getApi();
  const found = await api.accounts.search({ q, limit: 8 });
  return found.map((a) => ({ number: a.number, customerName: a.customerName }));
}

const holds = (session: Session, permission: Parameters<Session["access"]["permissions"]["includes"]>[0]) => session.access.permissions.includes(permission);

/** An account number from a URL segment. */
export const accountNumberFrom = (segment: string) => decodeURIComponent(segment);

/**
 * Everything the account page shows (C-01 to C-12). Reads each part through its own
 * procedure, so a part the member may not see (or that does not apply) is simply absent.
 */
export async function getAccountPage(number: string) {
  // "Today" for the change-of-name date is the clock in the organization's time zone.
  const [session] = await Promise.all([requireAccounts(), connection()]);
  const { api } = await getApi();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: session.organization.settings.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const account = await orNull(api.accounts.get({ number }));
  if (!account) notFound();

  const pending = account.commercialStatus === "NEW" || account.commercialStatus === "PENDING_PAYMENT";
  const canChange = session.access.permissions.includes("accounts:change_status");
  const [customer, commands, holders, activation, relocations, classes, categories, places, people, approvals] = await Promise.all([
    orNull(api.accounts.customers.get({ id: account.customerId })),
    api.accounts.commands.list({ accountId: account.id, limit: 100 }),
    api.accounts.holders.list({ accountId: account.id }),
    pending ? api.accounts.activation.status({ accountId: account.id }) : Promise.resolve(null),
    api.accounts.relocations.list({ accountId: account.id, limit: 50 }),
    api.accounts.memberships.classes(),
    getCategories(),
    getPlaceNames(),
    listPeople(),
    // Write-off requests for this account, so terminating can cite an approved one.
    canChange ? Promise.all([api.approvals.list({ view: "open" }), api.approvals.list({ view: "closed" })]).then((lists) => lists.flat()) : Promise.resolve([]),
  ]);
  const writeOffs = approvals
    .filter((a) => a.kind === "accounts.write_off" && a.subjectRef === account.id)
    .map((a) => ({ id: a.id, status: a.status, amount: a.amount, reason: a.reasonLabel, requestedAt: a.requestedAt }));

  // Holders and the succession links name other customers and accounts the member may not see: fall back to a plain label.
  const holderIds = [...new Set(holders.map((h) => h.customerId))];
  const holderNames = new Map(
    await Promise.all(holderIds.map(async (id) => [id, (await orNull(api.accounts.customers.get({ id })))?.name ?? "Another customer"] as const)),
  );
  const link = async (id: string | null) => (id ? ((await orNull(api.accounts.get({ id })))?.number ?? null) : null);
  const [predecessorNumber, successorNumber] = await Promise.all([link(account.predecessorAccountId), link(account.successorAccountId)]);
  const parentName = account.parent ? ((await orNull(api.accounts.get({ id: account.parent.id })))?.customerName ?? null) : null;

  return {
    account,
    customer,
    parentName,
    commands: commands.map((c) => ({ ...c, actor: c.source === "system" ? "Flowless" : (nameOf(people, c.actorUserId) ?? "A colleague") })),
    holders: holders.map((h) => ({ ...h, name: holderNames.get(h.customerId) ?? "Another customer" })),
    activation:
      activation && {
        ...activation,
        gates: activation.gates.map((g) => ({ ...g, tickedBy: nameOf(people, g.tickedByUserId) })),
      },
    relocations,
    membership: account.membershipClass ? (classes.find((c) => c.key === account.membershipClass)?.label ?? account.membershipClass) : null,
    categoryName: categories.licensed && account.categoryId ? (categories.categories.find((c) => c.id === account.categoryId)?.name ?? "Unknown category") : null,
    showCategory: categories.licensed,
    categories: categories.categories.filter((c) => c.active),
    placeName: { area: places.area, route: places.route },
    writeOffs,
    placeOptions: {
      areas: places.areas.map(({ id, name, level, parentId }) => ({ id, name, level, parentId })),
      routes: places.routes.map(({ id, name, code }) => ({ id, name: code + " · " + name })),
    },
    predecessorNumber,
    successorNumber,
    can: {
      update: holds(session, "accounts:update"),
      changeStatus: holds(session, "accounts:change_status"),
      overrideGates: holds(session, "settings:manage"),
    },
    permissions: session.access.permissions,
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
    currency: session.organization.settings.currency,
    today,
  };
}
export type AccountPage = Awaited<ReturnType<typeof getAccountPage>>;
