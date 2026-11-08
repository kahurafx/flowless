import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { toUploadSpec } from "../lib/attachments";
import { now, uid } from "../lib/ids";
import type { Abilities } from "../lib/permissions";
import { finishOps, photosStillNeeded, uploadOps } from "../lib/sync/build";
import type { Op } from "../lib/sync/ops";
import type { AppNode, JobAsset, LatLng, LocalFile, WorkKind, WorkOrder, WorkOrderOutcome } from "../lib/types";
import { captureProblem, captureValue, jobProgress, kindInfo, toGeoPoint } from "../lib/work-orders";
import type { Enqueue } from "./sync";
import { useActions } from "./use-actions";

/**
 * The jobs area (W-01 to W-03): the jobs this person can see, the kinds they may raise, and the
 * actions on a job. Like the rest of the app these are local-first: each action changes what the
 * phone shows at once and queues the exact call(s) it stands for.
 *
 * The functions copy the rules the server enforces (review policy, evidence, route jobs need every
 * asset done, nobody approves their own work) so the screens behave the way the real thing will; the
 * server stays the authority and answers a refusal as a `rejected` outcome on the Sync screen.
 */
export type ActionResult = { ok: true } | { ok: false; reason: string };

export type FinishInput = {
  outcome: WorkOrderOutcome;
  note: string;
  files: LocalFile[];
  /** Send for approval rather than complete. */
  submit: boolean;
  /** The kind's completion data (W-03). */
  capture?: Record<string, string>;
  /** Where the work was done, required by kinds with GPS evidence (W-02). */
  position?: LatLng | null;
};

export type RaiseInput = {
  title: string;
  description: string;
  kind: string;
  assetId: string | null;
  areaId: string | null;
  location: LatLng | null;
  locationNote: string | null;
  files: LocalFile[];
};

export type JobsValue = {
  kinds: WorkKind[];
  workOrders: WorkOrder[];
  /** Assigned to me, not cancelled. */
  myOrders: WorkOrder[];
  /** Submitted by someone else, for a member who may review. */
  approvals: WorkOrder[];
  finishOrder: (id: string, c: FinishInput) => ActionResult;
  holdOrder: (id: string, h: { reason: string; note: string; files: LocalFile[] }) => ActionResult;
  resumeOrder: (id: string) => void;
  reviewOrder: (id: string, decision: "approve" | "return", note: string) => ActionResult;
  finalizeOrder: (id: string, c: { outcome: WorkOrderOutcome; note: string }) => ActionResult;
  addJobAsset: (orderId: string, assetId: string) => void;
  raiseJob: (input: RaiseInput) => string;
};

export const JobsContext = createContext<JobsValue | null>(null);
export function useJobs(): JobsValue {
  const v = useContext(JobsContext);
  if (!v) throw new Error("useJobs must be used inside <AppProvider>");
  return v;
}

/** What field actions on the network need from jobs. */
export type JobLinks = {
  orderOf: (id: string) => WorkOrder | undefined;
  /** The log's asset joins the job (if it wasn't on it) and is done. */
  touchOrder: (workOrderId: string, asset: Pick<AppNode, "id" | "name" | "type">) => void;
  /** A new asset joins the job as proposed. */
  attachToJob: (orderId: string, a: { assetId: string; name: string; type: string; state: JobAsset["state"] }) => void;
};

const fail = (reason: string): ActionResult => ({ ok: false, reason });
const ok: ActionResult = { ok: true };

export function useJobsState(deps: { userId: string; abilities: Abilities; nodes: readonly AppNode[]; enqueue: Enqueue; onReviewed: (code: string, approved: boolean) => void }) {
  const { userId, abilities, nodes, enqueue, onReviewed } = deps;
  const [kinds, setKinds] = useState<WorkKind[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);

  const orderOf = (id: string) => workOrders.find((o) => o.id === id);
  const patchOrder = (id: string, fn: (o: WorkOrder) => WorkOrder) => setWorkOrders((os) => os.map((o) => (o.id === id ? fn(o) : o)));

  /**
   * Nobody taps Start: the first thing the assignee does on a job starts it. The server does the
   * same when the op that stands for that action arrives, so nothing extra is queued.
   */
  const autoStart = (o: WorkOrder): WorkOrder => (o.status === "pending" && o.assignedToUserId === userId ? { ...o, status: "in_progress", startedAt: new Date() } : o);

  const attachToJob: JobLinks["attachToJob"] = (orderId, a) =>
    patchOrder(orderId, (o) => {
      if (o.assets.some((x) => x.assetId === a.assetId)) return o;
      const asset: JobAsset = {
        module: "gis",
        assetId: a.assetId,
        role: o.assets.length === 0 && !o.assetId ? "primary" : "related",
        status: "pending",
        doneAt: null,
        name: a.name,
        type: a.type,
        state: a.state,
        possibleDuplicateOf: null,
      };
      return { ...autoStart(o), assets: [...o.assets, asset] };
    });

  const touchOrder: JobLinks["touchOrder"] = (workOrderId, asset) =>
    patchOrder(workOrderId, (o) => {
      if (o.status !== "pending" && o.status !== "in_progress") return o;
      const started = autoStart(o);
      const has = started.assets.some((a) => a.assetId === asset.id);
      const at = new Date();
      const assets: JobAsset[] = has
        ? started.assets.map((a) => (a.assetId === asset.id && a.status !== "done" ? { ...a, status: "done", doneAt: at } : a))
        : [...started.assets, { module: "gis", assetId: asset.id, role: "related", status: "done", doneAt: at, name: asset.name, type: asset.type, state: "registered", possibleDuplicateOf: null }];
      return { ...started, assets };
    });

  const finishOrder: JobsValue["finishOrder"] = (id, c) => {
    const o = orderOf(id);
    if (!o) return fail("Work order not found");
    if (o.status === "completed" || o.status === "cancelled") return fail(`This job is ${o.status}`);
    if (o.status === "submitted") return fail("This job is awaiting approval");
    if (workOrders.some((x) => x.parentId === id) && !abilities.review) return fail("This job is made up of parts. Finish the parts instead.");
    if (o.review === "required" && !c.submit) return fail("This kind of job needs approval. Submit it instead.");
    const kind = kindInfo(kinds, o.kind);
    const { done, total } = jobProgress(o);
    if (c.outcome === "done" && kind?.target === "assets" && total - done > 0) return fail(`${total - done} asset${total - done === 1 ? "" : "s"} still to do`);

    const photos = c.files.filter((f) => f.kind === "photo").length;
    const missing = photosStillNeeded(kind?.evidence, o.photoCount, photos);
    if (missing > 0) return fail(`Add ${missing} more photo${missing === 1 ? "" : "s"} of the work`);
    if (kind?.evidence.gps && !c.position) return fail("This kind of job needs your GPS position. Turn on location and try again.");
    const problem = captureProblem(kind, c.capture ?? {});
    if (problem) return fail(problem);

    const at = now();
    patchOrder(id, (x) => {
      const base = { ...autoStart(x), photoCount: x.photoCount + photos };
      return c.submit
        ? { ...base, status: "submitted", reviewed: null, submission: { at: new Date(at), byUserId: userId, outcome: c.outcome, note: c.note } }
        : { ...base, status: "completed", completion: { at: new Date(at), outcome: c.outcome, note: c.note, photoCount: x.photoCount + photos } };
    });
    const transition: Extract<Op, { proc: "workOrders.transition" }> = {
      proc: "workOrders.transition",
      input: {
        eventId: uid(),
        workOrderId: id,
        occurredAt: at,
        ...(c.position ? { position: toGeoPoint(c.position) } : {}),
        action: { type: c.submit ? "submit" : "complete", outcome: c.outcome, note: c.note, ...(captureValue(kind, c.capture ?? {}) ? { capture: captureValue(kind, c.capture ?? {}) } : {}) },
      },
    };
    enqueue({ kind: "workorder", assetId: null, title: c.submit ? "Sent for approval" : "Job completed", assetName: o.title, detail: o.code }, finishOps(transition, c.files.map(toUploadSpec)), undefined, "success");
    return ok;
  };

  const holdOrder: JobsValue["holdOrder"] = (id, h) => {
    const o = orderOf(id);
    if (!o) return fail("Work order not found");
    if (o.status === "completed" || o.status === "cancelled" || o.status === "submitted") return fail(o.status === "submitted" ? "This job is awaiting approval" : `This job is ${o.status}`);
    const photos = h.files.filter((f) => f.kind === "photo").length;
    patchOrder(id, (x) => ({ ...autoStart(x), status: "blocked", photoCount: x.photoCount + photos, hold: { reason: h.reason, note: h.note, at: new Date() } }));
    // Photos first, as for finishing: the job's files are then in place when the hold lands.
    const ops: Op[] = [
      ...uploadOps(h.files.map(toUploadSpec), { kind: "work_order", id }),
      { proc: "workOrders.transition", input: { eventId: uid(), workOrderId: id, occurredAt: now(), action: { type: "hold", reason: h.reason, note: h.note } } },
    ];
    enqueue({ kind: "workorder", assetId: null, title: "Couldn't finish", assetName: o.title, detail: h.reason }, ops, undefined, "warning");
    return ok;
  };

  const resumeOrder: JobsValue["resumeOrder"] = (id) => {
    const o = orderOf(id);
    patchOrder(id, (x) => (x.status === "blocked" ? { ...x, status: "in_progress", hold: null } : x));
    enqueue({ kind: "workorder", assetId: null, title: "Job resumed", assetName: o?.title ?? "", detail: o?.code ?? "" }, [
      { proc: "workOrders.transition", input: { eventId: uid(), workOrderId: id, occurredAt: now(), action: { type: "resume" } } },
    ]);
  };

  const reviewOrder: JobsValue["reviewOrder"] = (id, decision, note) => {
    const o = orderOf(id);
    if (!o) return fail("Work order not found");
    if (!abilities.review) return fail("Only supervisors can review work");
    if (o.status !== "submitted" || !o.submission) return fail("This job isn't waiting for approval");
    if (o.submission.byUserId === userId) return fail("You can't review work you submitted yourself");
    if (decision === "return" && !note.trim()) return fail("Say what needs fixing");
    const at = new Date();
    const submission = o.submission;
    const reviewed = { at, byUserId: userId, decision: decision === "approve" ? ("approved" as const) : ("returned" as const), note: note.trim() };
    patchOrder(id, (x) =>
      decision === "approve"
        ? { ...x, status: "completed", submission: null, reviewed, completion: { at, outcome: submission.outcome, note: submission.note, photoCount: x.photoCount } }
        : { ...x, status: "in_progress", submission: null, reviewed },
    );
    enqueue(
      { kind: "workorder", assetId: null, title: decision === "approve" ? "Work approved" : "Sent back", assetName: o.title, detail: o.code },
      [{ proc: "workOrders.review", input: { eventId: uid(), workOrderId: id, decision, note: note.trim(), occurredAt: at.toISOString() } }],
      decision === "approve" ? "Approved. An engineer posts the data." : "Sent back to the technician",
      decision === "approve" ? "success" : "warning",
    );
    onReviewed(o.code, decision === "approve");
    return ok;
  };

  const finalizeOrder: JobsValue["finalizeOrder"] = (id, c) => {
    const o = orderOf(id);
    if (!o) return fail("Work order not found");
    if (!abilities.review) return fail("Only supervisors can finalize a job");
    if (o.status === "completed" || o.status === "cancelled") return fail(`This job is ${o.status}`);
    const at = new Date();
    patchOrder(id, (x) => ({ ...x, status: "completed", completion: { at, outcome: c.outcome, note: c.note, photoCount: x.photoCount } }));
    enqueue({ kind: "workorder", assetId: null, title: "Job finalized", assetName: o.title, detail: o.code }, [
      { proc: "workOrders.finalize", input: { eventId: uid(), workOrderId: id, outcome: c.outcome, note: c.note, occurredAt: at.toISOString() } },
    ], "Job finalized", "success");
    return ok;
  };

  const addJobAsset: JobsValue["addJobAsset"] = (orderId, assetId) => {
    const n = nodes.find((x) => x.id === assetId);
    if (!n) return;
    attachToJob(orderId, { assetId, name: n.name, type: n.type, state: "registered" });
    enqueue({ kind: "workorder", assetId: null, title: "Asset added to job", assetName: n.name, detail: orderOf(orderId)?.code ?? "" }, [
      { proc: "workOrders.addAsset", input: { eventId: uid(), workOrderId: orderId, assetId, occurredAt: now() } },
    ]);
  };

  /** A technician reporting something they found. The server assigns it to them, always reviewed, source "Field report". */
  const raiseJob: JobsValue["raiseJob"] = (input) => {
    const id = uid();
    const n = input.assetId ? nodes.find((x) => x.id === input.assetId) : undefined;
    const kind = kindInfo(kinds, input.kind);
    const photos = input.files.filter((f) => f.kind === "photo").length;
    const at = new Date();
    const created: WorkOrder = {
      id,
      // The real code is handed out when it reaches the server.
      code: "New",
      title: input.title,
      description: input.description,
      kind: input.kind,
      priority: "normal",
      status: "pending",
      review: kind?.review ?? "required",
      source: "Field report",
      parentId: null,
      assetModule: n ? "gis" : null,
      assetId: input.assetId,
      areaId: input.areaId,
      routeId: null,
      location: input.location ? toGeoPoint(input.location) : null,
      locationNote: input.locationNote,
      assignedToUserId: userId,
      crewId: null,
      dueAt: new Date(at.getTime() + 7 * 86_400_000),
      overdue: false,
      createdAt: at,
      createdByUserId: userId,
      startedAt: null,
      photoCount: photos,
      branch: null,
      assets: n
        ? [{ module: "gis", assetId: n.id, role: "primary", status: "pending", doneAt: null, name: n.name, type: n.type, state: "registered", possibleDuplicateOf: null }]
        : [],
      capture: null,
      hold: null,
      submission: null,
      reviewed: null,
      completion: null,
    };
    setWorkOrders((os) => [created, ...os]);
    enqueue(
      { kind: "workorder", assetId: null, title: "Problem reported", assetName: input.title, detail: "Code is given when it uploads" },
      [
        {
          proc: "workOrders.create",
          input: {
            id,
            title: input.title,
            description: input.description,
            kind: input.kind,
            assetId: input.assetId,
            areaId: input.areaId,
            location: input.location ? toGeoPoint(input.location) : null,
            locationNote: input.locationNote,
          },
        },
        ...uploadOps(input.files.map(toUploadSpec), { kind: "work_order", id }),
      ],
    );
    return id;
  };

  const actions = useActions({ finishOrder, holdOrder, resumeOrder, reviewOrder, finalizeOrder, addJobAsset, raiseJob });
  const links = useActions({ orderOf, touchOrder, attachToJob });

  const myOrders = useMemo(() => workOrders.filter((o) => o.assignedToUserId === userId && o.status !== "cancelled"), [workOrders, userId]);
  const approvals = useMemo(
    () => (abilities.review ? workOrders.filter((o) => o.status === "submitted" && o.submission && o.submission.byUserId !== userId) : []),
    [workOrders, abilities.review, userId],
  );
  const value = useMemo<JobsValue>(() => ({ kinds, workOrders, myOrders, approvals, ...actions }), [kinds, workOrders, myOrders, approvals, actions]);
  const setKindsStable = useCallback((k: WorkKind[]) => setKinds(k), []);
  return { value, links, kinds, workOrders, setKinds: setKindsStable, setWorkOrders };
}
