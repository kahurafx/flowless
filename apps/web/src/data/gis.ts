import { MAIN_BRANCH, personalBranch } from "@flowless/shared-types";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { listPeople, nameOf } from "./people";
import { getApi, requireModule } from "./session";

type Api = Awaited<ReturnType<typeof getApi>>["api"];
export type NodeDto = Awaited<ReturnType<Api["gis"]["nodes"]["list"]>>[number];
export type PipeDto = Awaited<ReturnType<Api["gis"]["pipes"]["list"]>>[number];
export type StructureDto = Awaited<ReturnType<Api["gis"]["structures"]["list"]>>[number];
export type ConnectionDto = Awaited<ReturnType<Api["gis"]["connections"]["list"]>>[number];
export type DmaDto = Awaited<ReturnType<Api["gis"]["dmas"]["list"]>>[number];
export type TierDto = Awaited<ReturnType<Api["gis"]["tiers"]["list"]>>[number];
type BranchSummary = Awaited<ReturnType<Api["gis"]["reconcile"]["branches"]>>[number];

export interface BranchChoice {
  branch: string;
  label: string;
  /** What kind of branch it is, for grouping in the chooser. */
  kind: "main" | "mine" | "job" | "other";
}

const BRANCH_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** A branch name from the address bar, or main when it is missing or not a valid name. */
export const branchFrom = (value: string | string[] | undefined): string =>
  typeof value === "string" && BRANCH_PATTERN.test(value) ? value : MAIN_BRANCH;

const branchLabel = (b: BranchSummary): string => (b.origin ? `${b.origin.ref} · ${b.origin.title}` : b.branch);

/**
 * Everything the network map starts with, for one branch (the live network, a job's branch or a
 * personal field branch): the network as that branch sees it, who may do what, and the branches to
 * switch to. The map re-reads this after every edit (the server actions call `refresh()`).
 */
export async function getNetworkMap(params: { branch: string; jobId?: string; dmaId?: string }) {
  const [session] = await Promise.all([requireModule("gis", "gis:read"), connection()]);
  const { api } = await getApi();
  const { branch } = params;
  const [nodes, pipes, structures, connections, dmas, tiers, branches, areas] = await Promise.all([
    api.gis.nodes.list({ branch }),
    api.gis.pipes.list({ branch }),
    api.gis.structures.list({ branch }),
    api.gis.connections.list({ branch }),
    api.gis.dmas.list({ branch }),
    api.gis.tiers.list(),
    api.gis.reconcile.branches(),
    api.hierarchy.areas(),
  ]);
  const can = (p: "gis:edit" | "gis:delete" | "gis:post") => session.access.permissions.includes(p);

  const mine = personalBranch(session.user.id);
  const choices: BranchChoice[] = [{ branch: MAIN_BRANCH, label: "Live network", kind: "main" }];
  if (can("gis:edit")) choices.push({ branch: mine, label: "My field branch", kind: "mine" });
  for (const b of branches) {
    if (b.branch === mine) continue;
    choices.push({ branch: b.branch, label: branchLabel(b), kind: b.origin ? "job" : "other" });
  }
  // A requested branch with no edits yet (a job's fresh branch, someone's empty one) is still a place to work.
  const job = params.jobId && /^[0-9a-f-]{36}$/i.test(params.jobId) && session.organization.entitlements.some((m) => m === "work-orders" || m === "gis")
    ? await api.workOrders.byId({ id: params.jobId }).catch(() => null)
    : null;

  if (!choices.some((c) => c.branch === branch)) {
    choices.push({ branch, label: job && job.branch === branch ? `${job.code} · ${job.title}` : branch, kind: branch.startsWith("wo-") ? "job" : "other" });
  }

  const mapped = new Set(dmas.map((d) => d.id));
  const all = [...nodes.map((n) => n.location), ...pipes.flatMap((p) => p.path.slice(0, 1)), ...structures.map((s) => s.location)];
  const center = all.length
    ? { lat: all.reduce((s, p) => s + p.lat, 0) / all.length, lng: all.reduce((s, p) => s + p.lng, 0) / all.length }
    : { lat: -1.2921, lng: 36.7819 };

  return {
    branch,
    branches: choices,
    nodes,
    pipes,
    structures,
    connections,
    dmas,
    tiers,
    /** Kernel DMAs that have no map data yet: candidates for "draw a boundary". */
    undrawnDmas: areas.filter((a) => a.level === "dma" && !a.archivedAt && !mapped.has(a.id)).map((a) => ({ id: a.id, name: a.name })),
    job: job ? { id: job.id, code: job.code, title: job.title, status: job.status, branch: job.branch } : null,
    initialDmaId: params.dmaId && mapped.has(params.dmaId) ? params.dmaId : null,
    center,
    can: { edit: can("gis:edit"), remove: can("gis:delete"), post: can("gis:post") },
    myBranch: mine,
    userId: session.user.id,
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
  };
}

export type NetworkMapData = Awaited<ReturnType<typeof getNetworkMap>>;

/** Pending branches with who is editing them and where each came from (`gis:post`). */
export async function listPendingBranches() {
  const [session] = await Promise.all([requireModule("gis", "gis:post"), connection()]);
  const { api } = await getApi();
  const [branches, people] = await Promise.all([api.gis.reconcile.branches(), listPeople()]);
  return {
    rows: branches.map((b) => ({
      branch: b.branch,
      changes: b.changes,
      firstEditAt: b.firstEditAt,
      lastEditAt: b.lastEditAt,
      authors: b.authorIds.map((id) => nameOf(people, id) ?? "A colleague"),
      origin: b.origin,
    })),
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
  };
}

export type PendingBranch = Awaited<ReturnType<typeof listPendingBranches>>["rows"][number];

/** What posting one branch would do (`gis:post`): entity by entity, with conflicts and missing photos. */
export async function getBranchPreview(branch: string) {
  const [session] = await Promise.all([requireModule("gis", "gis:post"), connection()]);
  if (!BRANCH_PATTERN.test(branch) || branch === MAIN_BRANCH) notFound();
  const { api } = await getApi();
  const [preview, pending] = await Promise.all([api.gis.reconcile.preview({ branch }).catch(() => null), api.gis.reconcile.branches()]);
  // A branch with nothing left on it (already posted or discarded) is not found.
  if (!preview) notFound();
  const summary = pending.find((b) => b.branch === branch);
  const people = await listPeople();
  return {
    ...preview,
    authors: (summary?.authorIds ?? []).map((id) => nameOf(people, id) ?? "A colleague"),
    lastEditAt: summary?.lastEditAt ?? null,
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
  };
}

export type BranchPreview = Awaited<ReturnType<typeof getBranchPreview>>;
