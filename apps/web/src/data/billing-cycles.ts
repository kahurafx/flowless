import { notFound } from "next/navigation";
import { connection } from "next/server";
import { accountLabels } from "./account-labels";
import { getPlaceNames } from "./accounts";
import { getHierarchy } from "./hierarchy";
import { listPeople, nameOf } from "./people";
import { getApi, requireModule } from "./session";
import { CYCLE_STATES, previousPeriod, type CycleOutcomeKey, type CycleStateKey } from "@/lib/cycle-view";

type Api = Awaited<ReturnType<typeof getApi>>["api"];
export type CycleListRow = Awaited<ReturnType<Api["billing"]["cycles"]["list"]>>[number];
export type CycleProgress = Awaited<ReturnType<Api["billing"]["cycles"]["progress"]>>;
export type CycleCompleteness = Awaited<ReturnType<Api["billing"]["cycles"]["completeness"]>>;
export type CycleReviewQueue = Awaited<ReturnType<Api["billing"]["cycles"]["review"]["queue"]>>;
export type CycleAccountsPage = Awaited<ReturnType<Api["billing"]["cycles"]["accounts"]>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CYCLE_ACCOUNTS_PAGE = 100;

/** Billing licensed and `billing:read`; running cycles needs `billing:run`, deciding a large bill `billing:approve`. */
export const requireBilling = () => requireModule("billing", "billing:read");

/** Billing cycles, newest first, with route names (B-02). */
export async function listBillingCycles(filter: { routeId?: string | undefined; state?: string | undefined }) {
  await connection();
  const session = await requireBilling();
  const { api } = await getApi();
  const state = CYCLE_STATES.find((s) => s === filter.state);
  const [cycles, hierarchy] = await Promise.all([
    api.billing.cycles.list({ limit: 100, ...(filter.routeId && UUID.test(filter.routeId) ? { routeId: filter.routeId } : {}), ...(state ? { state } : {}) }),
    getHierarchy(),
  ]);
  const routes = hierarchy.routes.filter((r) => !r.archivedAt);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: session.organization.settings.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return {
    canRun: session.access.permissions.includes("billing:run"),
    locale: session.organization.settings.locale,
    defaultPeriod: previousPeriod(today),
    today,
    routes: routes.map((r) => ({ id: r.id, name: r.name })),
    rows: cycles.map((c) => ({ ...c, routeName: hierarchy.routes.find((r) => r.id === c.routeId)?.name ?? c.routeId.slice(0, 8) })),
  };
}

/**
 * One cycle: the state line and its events, progress (counts, flagged, jobs, failures), the
 * completeness check, the accounts (filtered by outcome, paged) and, from the review state on,
 * the review queue (B-02 to B-04, B-16).
 */
export async function getBillingCycle(id: string, params: { outcome?: string | undefined; page?: number | undefined }) {
  await connection();
  const session = await requireBilling();
  if (!UUID.test(id)) notFound();
  const { api } = await getApi();
  const outcome = (["billed", "billed_estimate", "exception", "excluded", "none"] as const).find((o) => o === params.outcome);
  const page = Math.max(0, params.page ?? 0);
  let detail;
  try {
    detail = await api.billing.cycles.get({ cycleId: id });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "NOT_FOUND") notFound();
    throw error;
  }
  const reviewing = (["review", "issue", "deliver", "completeness", "closed"] as const).some((s) => s === detail.state);
  const [progress, accounts, queue, people, places] = await Promise.all([
    api.billing.cycles.progress({ cycleId: id }),
    api.billing.cycles.accounts({ cycleId: id, limit: CYCLE_ACCOUNTS_PAGE, offset: page * CYCLE_ACCOUNTS_PAGE, ...(outcome ? { outcome } : {}) }),
    reviewing ? api.billing.cycles.review.queue({ cycleId: id }) : Promise.resolve(null),
    listPeople(),
    getPlaceNames().catch(() => null),
  ]);
  const labels = await accountLabels([...accounts.rows.map((r) => r.accountId), ...(queue?.pending.map((p) => p.accountId) ?? []), ...progress.failures.map((f) => f.accountId), ...detail.completeness.examples.map((e) => e.accountId)]);
  return {
    cycle: detail,
    routeName: places?.route(detail.routeId) ?? detail.routeId.slice(0, 8),
    progress,
    accounts,
    page,
    outcome: outcome ?? null,
    queue,
    labels: Object.fromEntries([...labels]),
    openedBy: nameOf(people, detail.openedByUserId) ?? "The system",
    eventActors: Object.fromEntries(detail.events.map((e) => [e.id, nameOf(people, e.actorUserId) ?? "The system"])),
    canRun: session.access.permissions.includes("billing:run"),
    canApprove: session.access.permissions.includes("billing:approve"),
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
    currency: session.organization.settings.currency,
  };
}
export type CyclePage = Awaited<ReturnType<typeof getBillingCycle>>;
export type CycleAccountRowView = CyclePage["accounts"]["rows"][number];
export type { CycleOutcomeKey, CycleStateKey };
