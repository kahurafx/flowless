import { describe, expect, it } from "vitest";
import { finishOps, photosStillNeeded, uploadOps, createOps, type UploadSpec } from "./build";
import type { Op, OpOutcome, SyncItem, Transport } from "./ops";
import { isUnsent, runQueue, syncMessage, uploadPaths } from "./queue";

/** A server that, like the real one, answers a repeated client-minted id with "replayed" instead of doing it twice. */
function fakeServer(options: { failOn?: (op: Op) => boolean; reject?: (op: Op) => string | undefined } = {}) {
  const received: string[] = [];
  const seen = new Set<string>();
  const idOf = (op: Op): string | null => {
    const input = op.input as { id?: string; eventId?: string };
    return input.id ?? input.eventId ?? null;
  };
  const transport: Transport = {
    async send(op) {
      if (options.failOn?.(op)) throw new Error("offline");
      const reason = options.reject?.(op);
      if (reason) return { outcome: "rejected", reason } satisfies OpOutcome;
      const id = idOf(op);
      if (id && seen.has(id)) return { outcome: "replayed" };
      if (id) seen.add(id);
      received.push(`${op.proc}:${id ?? "-"}`);
      return { outcome: "applied" };
    },
  };
  return { transport, received };
}

const item = (id: string, ops: Op[], status: SyncItem["status"] = "queued"): SyncItem => ({
  id,
  kind: "workorder",
  assetId: null,
  title: id,
  assetName: "",
  detail: "",
  at: "2026-01-01T00:00:00.000Z",
  status,
  ops,
});

const J = "00000000-0000-4000-8000-000000000001";
const cond = (id: string): Op => ({
  proc: "gis.logs.recordCondition",
  input: { id, assetId: "a", branch: "main", condition: "poor", note: "", recordedAt: "2026-01-01T00:00:00.000Z" },
});
const link = (eventId: string, logId: string): Op => ({
  proc: "workOrders.linkLog",
  input: { eventId, workOrderId: J, logKind: "condition", logId, occurredAt: "2026-01-01T00:00:00.000Z" },
});
const complete = (eventId: string): Extract<Op, { proc: "workOrders.transition" }> => ({
  proc: "workOrders.transition",
  input: { eventId, workOrderId: J, occurredAt: "2026-01-01T00:00:00.000Z", action: { type: "complete", outcome: "done", note: "" } },
});
const photo = (id: string): UploadSpec => ({ id, fileName: `${id}.jpg`, mimeType: "image/jpeg", sizeBytes: 10, path: `attachments/${id}.jpg` });

const collect = () => {
  const updates: Record<string, { status: string; error?: string }> = {};
  return { updates, update: (id: string, patch: { status: string; error?: string }) => void (updates[id] = patch) };
};

describe("queue ordering", () => {
  it("sends items oldest first and each item's ops in the order they were made", async () => {
    const { transport, received } = fakeServer();
    const { update, updates } = collect();
    const run = await runQueue(
      [item("one", [cond("c1"), link("e1", "c1")]), item("two", [cond("c2"), link("e2", "c2")])],
      transport,
      update,
    );
    expect(received).toEqual(["gis.logs.recordCondition:c1", "workOrders.linkLog:e1", "gis.logs.recordCondition:c2", "workOrders.linkLog:e2"]);
    expect(run).toEqual({ sent: 2, stoppedAt: null, refused: false });
    expect(updates).toMatchObject({ one: { status: "applied" }, two: { status: "applied" } });
  });

  it("stops at the first item that does not get through, so nothing behind it overtakes it", async () => {
    const { transport, received } = fakeServer({ failOn: (op) => op.proc === "workOrders.linkLog" });
    const { update, updates } = collect();
    const run = await runQueue([item("one", [cond("c1"), link("e1", "c1")]), item("two", [cond("c2")])], transport, update);
    expect(received).toEqual(["gis.logs.recordCondition:c1"]);
    expect(run.stoppedAt).toBe("one");
    expect(updates.one).toMatchObject({ status: "failed", error: "offline" });
    expect(updates.two).toBeUndefined();
  });

  it("carries on past a rejected item but stops that item's remaining ops", async () => {
    const { transport, received } = fakeServer({ reject: (op) => (op.proc === "gis.logs.recordCondition" && op.input.id === "bad" ? "Asset not found" : undefined) });
    const { update, updates } = collect();
    const run = await runQueue([item("one", [cond("bad"), link("e1", "bad")]), item("two", [cond("c2")])], transport, update);
    expect(received).toEqual(["gis.logs.recordCondition:c2"]);
    expect(updates.one).toEqual({ status: "rejected", error: "Asset not found" });
    expect(updates.two).toMatchObject({ status: "applied" });
    expect(run.refused).toBe(true);
  });

  it("only picks up unsent items", () => {
    expect([item("a", [], "queued"), item("b", [], "failed"), item("c", [], "applied"), item("d", [], "rejected"), item("e", [], "dropped")].filter(isUnsent).map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("replay of client-minted ids", () => {
  it("a retry after a lost connection repeats the item without doing anything twice", async () => {
    // The record lands, the link does not: the phone sees a failure and keeps the whole item.
    let linkFails = true;
    const server = fakeServer({ failOn: (op) => linkFails && op.proc === "workOrders.linkLog" });
    const queued = item("one", [cond("c1"), link("e1", "c1")]);
    const first = collect();
    await runQueue([queued], server.transport, first.update);
    expect(first.updates.one?.status).toBe("failed");

    linkFails = false;
    const second = collect();
    await runQueue([{ ...queued, ...first.updates.one, status: "queued" } as SyncItem], server.transport, second.update);
    // The condition log went up twice by the phone's count but exactly once by the server's.
    expect(server.received).toEqual(["gis.logs.recordCondition:c1", "workOrders.linkLog:e1"]);
    expect(second.updates.one?.status).toBe("applied");
  });

  it("a repeated item is answered as replayed", async () => {
    const server = fakeServer();
    const a = collect();
    await runQueue([item("one", [cond("c1")])], server.transport, a.update);
    const b = collect();
    await runQueue([item("one", [cond("c1")])], server.transport, b.update);
    expect(a.updates.one?.status).toBe("applied");
    expect(b.updates.one?.status).toBe("replayed");
    expect(server.received).toHaveLength(1);
  });

  it("the worst answer in an item is the one shown", async () => {
    const transport: Transport = {
      send: async (op) => (op.proc === "workOrders.linkLog" ? { outcome: "stale", reason: "This job is completed" } : { outcome: "applied" }),
    };
    const { update, updates } = collect();
    const run = await runQueue([item("one", [cond("c1"), link("e1", "c1")])], transport, update);
    expect(updates.one).toEqual({ status: "stale", error: "This job is completed" });
    expect(run.refused).toBe(true);
  });
});

describe("photos before the completing event", () => {
  it("uploads every photo, then completes", () => {
    const ops = finishOps(complete("done-1"), [photo("p1"), photo("p2")]);
    expect(ops.map((o) => o.proc)).toEqual(["files.upload", "files.upload", "workOrders.transition"]);
    expect(ops[0]).toMatchObject({ input: { subjectKind: "work_order", subjectId: J, id: "p1" } });
  });

  it("reaches the server in that order, so the evidence check sees the photos", async () => {
    const server = fakeServer();
    const { update } = collect();
    await runQueue([item("finish", finishOps(complete("done-1"), [photo("p1"), photo("p2")]))], server.transport, update);
    expect(server.received).toEqual(["files.upload:p1", "files.upload:p2", "workOrders.transition:done-1"]);
  });

  it("never completes when a photo is refused", async () => {
    const server = fakeServer({ reject: (op) => (op.proc === "files.upload" ? "At most 10 photos can be attached" : undefined) });
    const { update, updates } = collect();
    await runQueue([item("finish", finishOps(complete("done-1"), [photo("p1")]))], server.transport, update);
    expect(server.received).toEqual([]);
    expect(updates.finish).toEqual({ status: "rejected", error: "At most 10 photos can be attached" });
  });

  it("puts the files of a new record after the record, because the server must know it first", () => {
    const create: Op = { proc: "gis.nodes.create", input: { id: "n1", branch: "main", type: "meter", name: "M", location: { lat: 0, lng: 0 }, condition: "good", isOpen: null, structureId: null, junction: null } };
    expect(createOps(create, [photo("p1")], { kind: "gis_asset", id: "n1" }).map((o) => o.proc)).toEqual(["gis.nodes.create", "files.upload"]);
    expect(uploadOps([photo("p1")], { kind: "gis_asset", id: "n1" })[0]).toMatchObject({ input: { subjectKind: "gis_asset", subjectId: "n1" } });
  });

  it("counts the photos a kind still needs, including those already on the job", () => {
    expect(photosStillNeeded({ photos: 2 }, 0, 0)).toBe(2);
    expect(photosStillNeeded({ photos: 2 }, 1, 0)).toBe(1);
    expect(photosStillNeeded({ photos: 2 }, 1, 1)).toBe(0);
    expect(photosStillNeeded({ photos: 0 }, 0, 0)).toBe(0);
    expect(photosStillNeeded(undefined, 0, 0)).toBe(0);
  });
});

describe("messages and clean-up", () => {
  it("says the worst thing that happened", () => {
    expect(syncMessage({ stopped: true, pulled: false, sent: 1, refused: true }).message).toMatch(/Couldn't upload everything/);
    expect(syncMessage({ stopped: false, pulled: false, sent: 1, refused: false }).message).toMatch(/couldn't refresh/);
    expect(syncMessage({ stopped: false, pulled: true, sent: 1, refused: true }).message).toMatch(/weren't applied/);
    expect(syncMessage({ stopped: false, pulled: true, sent: 1, refused: false }).message).toBe("Changes uploaded");
    expect(syncMessage({ stopped: false, pulled: true, sent: 0, refused: false }).message).toBe("Already up to date");
  });

  it("lists the files a discarded item leaves on the phone", () => {
    expect(uploadPaths(finishOps(complete("d"), [photo("p1")]))).toEqual(["attachments/p1.jpg"]);
  });
});
