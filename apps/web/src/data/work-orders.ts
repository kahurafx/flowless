import { workLevel, type Permission, type WorkLevel } from "@flowless/shared-types";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { nameOf, listPeople, type Person } from "./people";
import { getApi, getSession, type Session } from "./session";

type Api = Awaited<ReturnType<typeof getApi>>["api"];
export type JobDto = Awaited<ReturnType<Api["workOrders"]["byId"]>>;
export type JobKind = Awaited<ReturnType<Api["workOrders"]["kinds"]>>[number];
export type JobEvent = Awaited<ReturnType<Api["workOrders"]["history"]>>[number];
export type JobComment = Awaited<ReturnType<Api["workOrders"]["comments"]>>[number];
export type JobFile = Awaited<ReturnType<Api["files"]["list"]>>[number];
export type Crew = Awaited<ReturnType<Api["workOrders"]["crews"]["list"]>>[number];

/** A job with the names its ids stand for, so the grid can search and sort on them. */
export interface JobRow extends JobDto {
  kindLabel: string;
  assignee: string | null;
  crewName: string | null;
  areaName: string | null;
}

const WORK_PERMISSIONS: readonly Permission[] = [
  "work_orders:read",
  "work_orders:execute",
  "work_orders:assign",
  "work_orders:review",
  "work_orders:cancel",
];

/**
 * Work Orders answers at level basic or full (W-01): the Work Orders module or GIS. A member
 * with no work-order permission sees nothing. Anything else is not found, as the procedures are.
 */
async function requireWork(extra?: Permission): Promise<Session & { level: WorkLevel }> {
  const session = await getSession();
  const level = workLevel(session.organization.entitlements);
  if (level === "none" || !WORK_PERMISSIONS.some((p) => session.access.permissions.includes(p))) notFound();
  if (extra && !session.access.permissions.includes(extra)) notFound();
  return { ...session, level };
}

const holds = (session: Session, p: Permission) => session.access.permissions.includes(p);
/** Sees jobs beyond their own (the Work Orders `visibility.all`). */
const seesAll = (session: Session) => (["work_orders:read", "work_orders:assign", "work_orders:review", "work_orders:cancel"] as const).some((p) => holds(session, p));

async function names(api: Api, people: Person[]) {
  const [areas, crews] = await Promise.all([api.hierarchy.areas({ includeArchived: true }), api.workOrders.crews.list({ includeArchived: true }).catch(() => [])]);
  return {
    area: (id: string | null) => (id ? (areas.find((a) => a.id === id)?.name ?? null) : null),
    crew: (id: string | null) => (id ? (crews.find((c) => c.id === id)?.name ?? null) : null),
    person: (id: string | null) => nameOf(people, id),
    areas: areas.filter((a) => !a.archivedAt),
    crews: crews.filter((c) => !c.archivedAt),
  };
}

/** The job list. A member who only executes sees "My jobs" (assigned to them or their crews). */
export async function listJobs() {
  // "Overdue" is derived from the clock.
  const [session] = await Promise.all([requireWork(), connection()]);
  const { api } = await getApi();
  const mineOnly = !seesAll(session);
  const [jobs, kinds, people] = await Promise.all([
    mineOnly ? api.workOrders.mine() : api.workOrders.list({ limit: 200 }),
    api.workOrders.kinds(),
    listPeople(),
  ]);
  const n = await names(api, people);
  const rows: JobRow[] = jobs.map((job) => ({
    ...job,
    kindLabel: kinds.find((k) => k.key === job.kind)?.label ?? job.kind,
    assignee: n.person(job.assignedToUserId),
    crewName: n.crew(job.crewId),
    areaName: n.area(job.areaId),
  }));
  return {
    rows,
    mineOnly,
    level: session.level,
    kinds: kinds.map(({ key, label }) => ({ key, label })),
    people,
    canRaise: kinds.some((k) => k.canRaise),
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
  };
}

/** What the "new job" form offers: the kinds this member can raise, who and where. */
export async function getNewJobForm() {
  const session = await requireWork();
  const { api } = await getApi();
  const gis = session.organization.entitlements.includes("gis") && holds(session, "gis:read");
  const [kinds, people] = await Promise.all([api.workOrders.kinds(), listPeople()]);
  const n = await names(api, people);
  const raisable = kinds.filter((k) => k.canRaise);
  if (raisable.length === 0) notFound();
  const assets = gis ? await listAssetChoices(api) : [];
  return {
    kinds: raisable,
    people,
    assignAnyone: holds(session, "work_orders:assign"),
    self: { id: session.user.id, name: session.user.name },
    areas: n.areas.map(({ id, name, level }) => ({ id, name, level })),
    crews: session.level === "full" ? n.crews.map(({ id, name }) => ({ id, name })) : [],
    assets,
  };
}

/** Live assets a job can target: nodes, pipes and structures on main. */
async function listAssetChoices(api: Api) {
  const [nodes, pipes, structures] = await Promise.all([api.gis.nodes.list(), api.gis.pipes.list(), api.gis.structures.list()]);
  const label = (s: string) => s.replaceAll("_", " ");
  return [
    ...nodes.map((x) => ({ id: x.id, label: `${x.name} (${label(x.type)})`, at: x.location })),
    ...structures.map((x) => ({ id: x.id, label: `${x.name} (${label(x.type)})`, at: x.location })),
    ...pipes.map((x) => ({ id: x.id, label: `Pipe ${x.diameterMm} mm ${label(x.material)}`, at: x.path[0] ?? null })),
  ].sort((a, b) => a.label.localeCompare(b.label));
}

export interface JobPage {
  job: JobRow;
  kind: JobKind | null;
  history: (JobEvent & { actor: string | null })[];
  comments: (JobComment & { author: string })[];
  files: JobFile[];
  children: JobRow[];
  people: Person[];
  crews: { id: string; name: string }[];
  /** What the viewer may do with this job right now (the procedures check again). */
  can: {
    act: boolean;
    assign: boolean;
    review: boolean;
    cancel: boolean;
    schedule: boolean;
    finalize: boolean;
    openBranch: boolean;
    seeMap: boolean;
  };
  userId: string;
  level: WorkLevel;
  locale: string;
  timeZone: string;
}

export async function getJob(id: string): Promise<JobPage> {
  const [session] = await Promise.all([requireWork(), connection()]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { api } = await getApi();
  const found = await api.workOrders.byId({ id }).catch(() => null);
  if (!found) notFound();
  const [kinds, history, comments, children, people, files, crewList] = await Promise.all([
    api.workOrders.kinds(),
    api.workOrders.history({ workOrderId: id }),
    api.workOrders.comments({ workOrderId: id }),
    api.workOrders.list({ parentId: id, limit: 50 }),
    listPeople(),
    api.files.list({ subjectKind: "work_order", subjectId: id }).catch(() => []),
    session.level === "full" ? api.workOrders.crews.list() : Promise.resolve([]),
  ]);
  const n = await names(api, people);
  const kind = kinds.find((k) => k.key === found.kind) ?? null;
  const toRow = (job: JobDto): JobRow => ({
    ...job,
    kindLabel: kinds.find((k) => k.key === job.kind)?.label ?? job.kind,
    assignee: n.person(job.assignedToUserId),
    crewName: n.crew(job.crewId),
    areaName: n.area(job.areaId),
  });

  const manager = holds(session, "work_orders:assign");
  const mine =
    found.assignedToUserId === session.user.id ||
    (found.crewId !== null && crewList.some((c) => c.id === found.crewId && c.memberUserIds.includes(session.user.id)));
  const open = found.status === "pending" || found.status === "in_progress" || found.status === "blocked";
  const act = open && (manager || (holds(session, "work_orders:execute") && mine));
  const gis = session.organization.entitlements.includes("gis");
  return {
    job: toRow(found),
    kind,
    history: history.map((e) => ({ ...e, actor: n.person(e.actorUserId) })),
    comments: comments.map((c) => ({ ...c, author: n.person(c.authorUserId) ?? "A colleague" })),
    files,
    children: children.map(toRow),
    people,
    crews: n.crews.map(({ id: crewId, name }) => ({ id: crewId, name })),
    can: {
      act,
      assign: manager && open,
      review: holds(session, "work_orders:review") && found.status === "submitted" && found.submission?.byUserId !== session.user.id,
      cancel: holds(session, "work_orders:cancel") && found.status !== "completed" && found.status !== "cancelled",
      schedule: manager && session.level === "full" && found.status !== "completed" && found.status !== "cancelled",
      finalize: holds(session, "work_orders:review") && children.length > 0 && (open || found.status === "pending"),
      openBranch: act && gis && holds(session, "gis:edit") && kind !== null && kind.gis !== "none" && found.status !== "blocked",
      seeMap: gis && holds(session, "gis:read"),
    },
    userId: session.user.id,
    level: session.level,
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
  };
}

/** Submitted jobs waiting for a decision (`work_orders:review`), oldest submission first. */
export async function listReviews() {
  const [session] = await Promise.all([requireWork("work_orders:review"), connection()]);
  const { api } = await getApi();
  const [jobs, kinds, people] = await Promise.all([api.workOrders.list({ statuses: ["submitted"], limit: 200 }), api.workOrders.kinds(), listPeople()]);
  const rows = jobs
    .map((job) => ({
      ...job,
      kindLabel: kinds.find((k) => k.key === job.kind)?.label ?? job.kind,
      submitter: nameOf(people, job.submission?.byUserId ?? null),
      own: job.submission?.byUserId === session.user.id,
    }))
    .sort((a, b) => (a.submission?.at.getTime() ?? 0) - (b.submission?.at.getTime() ?? 0));
  return { rows, locale: session.organization.settings.locale, timeZone: session.organization.settings.timeZone };
}

export type ReviewRow = Awaited<ReturnType<typeof listReviews>>["rows"][number];

/** Crews exist at level full only (the Work Orders module). */
export async function listCrews() {
  const session = await requireWork();
  if (session.level !== "full") notFound();
  const { api } = await getApi();
  const [crews, people] = await Promise.all([api.workOrders.crews.list(), listPeople()]);
  return {
    crews: crews.map((c) => ({ id: c.id, name: c.name, members: c.memberUserIds.map((id) => ({ id, name: nameOf(people, id) ?? "A colleague" })) })),
    people,
    canManage: holds(session, "work_orders:assign"),
  };
}
