import { workLevel, type ApplicationStage } from "@flowless/shared-types";
import { notFound } from "next/navigation";
import { getCategories, getPlaceNames, orNull, requireAccounts, PAGE_SIZE } from "./accounts";
import { listPeople, nameOf } from "./people";
import { getApi, getSession } from "./session";

type Api = Awaited<ReturnType<typeof getApi>>["api"];
export type ApplicationRow = Awaited<ReturnType<Api["accounts"]["applications"]["list"]>>[number];

/** Applications for new connections (C-05), oldest first, with the stage filter and keyset paging. */
export async function listApplications(params: { stage?: ApplicationStage | undefined; after?: string | undefined } = {}) {
  const session = await requireAccounts();
  const { api } = await getApi();
  const [page, categories, places] = await Promise.all([
    api.accounts.applications.list({ ...(params.stage ? { stage: params.stage } : {}), ...(params.after ? { after: params.after } : {}), limit: PAGE_SIZE + 1 }),
    getCategories(),
    getPlaceNames(),
  ]);
  const rows = page.slice(0, PAGE_SIZE).map((a) => ({
    ...a,
    categoryName: a.requestedCategoryId ? (categories.categories.find((c) => c.id === a.requestedCategoryId)?.name ?? null) : null,
    placeName: places.area(a.dmaId ?? a.zoneId ?? a.schemeId),
    routeName: places.route(a.routeId),
  }));
  return {
    rows,
    nextCursor: page.length > PAGE_SIZE ? (rows.at(-1)?.id ?? null) : null,
    showCategory: categories.licensed,
    canCreate: session.access.permissions.includes("accounts:create"),
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
  };
}

const WORK_PERMISSIONS = ["work_orders:read", "work_orders:execute", "work_orders:assign", "work_orders:review", "work_orders:cancel"] as const;

/** One application with its stage line inputs, survey, approval and history. */
export async function getApplicationPage(id: string) {
  const session = await requireAccounts();
  const { api } = await getApi();
  const application = await orNull(api.accounts.applications.get({ id }));
  if (!application) notFound();
  const [stages, categories, places, people, approval, account, parent] = await Promise.all([
    api.accounts.applications.stages(),
    getCategories(),
    getPlaceNames(),
    listPeople(),
    // The survey's approval is visible to the people involved in it; others just see its state.
    application.survey?.approvalId ? orNull(api.approvals.get({ id: application.survey.approvalId })) : Promise.resolve(null),
    application.accountId ? orNull(api.accounts.get({ id: application.accountId })) : Promise.resolve(null),
    application.parentAccountId ? orNull(api.accounts.get({ id: application.parentAccountId })) : Promise.resolve(null),
  ]);
  const permissions = session.access.permissions;
  return {
    application,
    stages: stages.stages,
    config: stages.config,
    events: application.events.map((e) => ({ ...e, actor: e.source === "system" ? "Flowless" : (nameOf(people, e.actorUserId) ?? "A colleague") })),
    surveyBy: application.survey ? nameOf(people, application.survey.recordedByUserId) : null,
    approval: approval && {
      id: approval.id,
      status: approval.status,
      waitingFor: approval.waitingFor,
      canDecide: approval.canDecide,
      decisions: approval.decisions.map((d) => ({ ...d, by: nameOf(people, d.byUserId) ?? "A colleague" })),
    },
    categoryName: application.requestedCategoryId ? (categories.categories.find((c) => c.id === application.requestedCategoryId)?.name ?? null) : null,
    showCategory: categories.licensed,
    area: places.area(application.dmaId ?? application.zoneId ?? application.schemeId),
    route: places.route(application.routeId),
    accountNumber: account?.number ?? null,
    parentNumber: parent?.number ?? null,
    createdBy: nameOf(people, application.createdByUserId),
    // Raising a survey job is Work Orders' business, offered only where it is licensed at level full (W-01).
    canRaiseSurveyJob: workLevel(session.organization.entitlements) === "full" && WORK_PERMISSIONS.some((p) => permissions.includes(p)),
    permissions,
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
  };
}
export type ApplicationPage = Awaited<ReturnType<typeof getApplicationPage>>;

/** Title, position and place for a survey job raised from an application (`/work-orders/new?kind=connection_survey&asset=<id>`). */
export async function getSurveyJobPrefill(applicationId: string) {
  const session = await getSession();
  if (!session.organization.entitlements.includes("accounts") || !session.access.permissions.includes("accounts:read")) return null;
  const { api } = await getApi();
  const application = await orNull(api.accounts.applications.get({ id: applicationId }));
  if (!application) return null;
  return {
    title: `Connection survey: ${application.customerName ?? "new customer"}`,
    description: application.notes ?? "",
    lat: application.location ? String(application.location.lat) : "",
    lng: application.location ? String(application.location.lng) : "",
    locationNote: application.address,
  };
}
