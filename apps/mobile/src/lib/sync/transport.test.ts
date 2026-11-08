import { TRPCClientError } from "@trpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Op } from "./ops";
// vi.mock calls below are hoisted above this import by Vitest, so the transport sees the mocks.
import { trpcTransport } from "./transport";

/*
 * The transport is where the Majimap-shaped ops meet Flowless's procedures. The network client and
 * the file system are replaced, so what is checked is which procedure each op calls, with what, in
 * which order, and how the server's answers (and refusals) are read.
 */
const m = vi.hoisted(() => {
  const mk = () => vi.fn();
  return {
    recordCondition: mk(), recordValve: mk(), nodesCreate: mk(), pipesCreate: mk(), structuresCreate: mk(), connectionsCreate: mk(),
    woCreate: mk(), changeSet: mk(), addAsset: mk(), linkLog: mk(), transition: mk(), review: mk(), finalize: mk(),
    announce: mk(), confirm: mk(), upload: mk(), exists: mk(), remove: mk(), calls: [] as string[],
  };
});

vi.mock("../api", () => ({
  api: {
    gis: {
      logs: { recordCondition: { mutate: m.recordCondition }, recordValveState: { mutate: m.recordValve } },
      nodes: { create: { mutate: m.nodesCreate } },
      pipes: { create: { mutate: m.pipesCreate } },
      structures: { create: { mutate: m.structuresCreate } },
      connections: { create: { mutate: m.connectionsCreate } },
    },
    workOrders: {
      create: { mutate: m.woCreate },
      changeSet: { mutate: m.changeSet },
      addAsset: { mutate: m.addAsset },
      linkLog: { mutate: m.linkLog },
      transition: { mutate: m.transition },
      review: { mutate: m.review },
      finalize: { mutate: m.finalize },
    },
    files: { announce: { mutate: m.announce }, confirm: { mutate: m.confirm } },
  },
}));
vi.mock("../attachments", () => ({
  fileAt: () => ({
    get exists() {
      return m.exists();
    },
    upload: m.upload,
    delete: m.remove,
  }),
}));
vi.mock("expo-file-system", () => ({ UploadType: { BINARY_CONTENT: 0 } }));

const trpcError = (code: string, message: string) => TRPCClientError.from({ error: { message, code: -32600, data: { code, httpStatus: 400 } } } as never);

const AT = "2026-03-01T08:00:00.000Z";
const J = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  m.calls.length = 0;
  m.exists.mockReturnValue(true);
  m.changeSet.mockResolvedValue({ workOrderId: J, branch: "wo-1042" });
  m.recordCondition.mockResolvedValue({ log: {}, outcome: "applied" });
  m.transition.mockResolvedValue({ order: {}, outcome: "applied", reason: undefined, replayed: false });
  m.announce.mockImplementation(async () => {
    m.calls.push("announce");
    return { file: { status: "pending" }, upload: { url: "https://bucket.example/put", headers: { "Content-Type": "image/jpeg", "Content-Length": "10" } } };
  });
  m.upload.mockImplementation(async () => {
    m.calls.push("put");
    return { status: 200, body: "", headers: {} };
  });
  m.confirm.mockImplementation(async () => {
    m.calls.push("confirm");
    return { file: {}, problem: null };
  });
});

const condition = (workOrderId?: string): Op => ({
  proc: "gis.logs.recordCondition",
  ...(workOrderId ? { workOrderId } : {}),
  input: { id: "c1", assetId: "a1", branch: "main", condition: "poor", note: "leaking", recordedAt: AT },
});

describe("procedure mapping", () => {
  it("records a log on main as it is, with its time as a Date", async () => {
    await expect(trpcTransport.send(condition())).resolves.toEqual({ outcome: "applied" });
    expect(m.changeSet).not.toHaveBeenCalled();
    expect(m.recordCondition).toHaveBeenCalledWith({ id: "c1", assetId: "a1", branch: "main", condition: "poor", note: "leaking", recordedAt: new Date(AT) });
  });

  it("asks the server for a job's branch, then records on it", async () => {
    await trpcTransport.send(condition(J));
    expect(m.changeSet).toHaveBeenCalledWith({ workOrderId: J });
    expect(m.recordCondition).toHaveBeenCalledWith(expect.objectContaining({ branch: "wo-1042" }));
  });

  it("creates assets on the job's branch too, and returns what the server said", async () => {
    m.nodesCreate.mockResolvedValue({ id: "n1" });
    const node = { id: "n1", branch: "new", type: "meter", name: "M", location: { lat: -1, lng: 36 }, condition: "good", isOpen: null, structureId: null, junction: null } as const;
    await expect(trpcTransport.send({ proc: "gis.nodes.create", workOrderId: J, input: node })).resolves.toEqual({ outcome: "applied" });
    expect(m.nodesCreate).toHaveBeenCalledWith({ ...node, branch: "wo-1042" });
  });

  it("calls each of the other procedures it is given", async () => {
    for (const mock of [m.pipesCreate, m.structuresCreate, m.connectionsCreate, m.woCreate, m.addAsset, m.linkLog, m.review, m.finalize, m.recordValve]) mock.mockResolvedValue({});
    const sent: Op[] = [
      { proc: "gis.pipes.create", input: { id: "p", branch: "fld-u", fromNodeId: "a", toNodeId: "b", path: [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }], material: "pvc", diameterMm: 100, condition: "good" } },
      { proc: "gis.structures.create", input: { id: "s", branch: "fld-u", type: "manhole", name: "MH", location: { lat: 0, lng: 0 }, condition: "good" } },
      { proc: "gis.connections.create", input: { id: "k", branch: "fld-u", connectionNumber: "KW-1", location: { lat: 0, lng: 0 }, pipeId: null } },
      { proc: "workOrders.create", input: { id: J, title: "Leak", description: "", kind: "leak", assetId: null, areaId: null, location: { latitude: -1, longitude: 36 }, locationNote: null } },
      { proc: "workOrders.addAsset", input: { eventId: "e1", workOrderId: J, assetId: "a", occurredAt: AT } },
      { proc: "workOrders.linkLog", input: { eventId: "e2", workOrderId: J, logKind: "valve", logId: "v", occurredAt: AT } },
      { proc: "workOrders.review", input: { eventId: "e3", workOrderId: J, decision: "approve", note: "", occurredAt: AT } },
      { proc: "workOrders.finalize", input: { eventId: "e4", workOrderId: J, outcome: "done", note: "", occurredAt: AT } },
      { proc: "gis.logs.recordValveState", input: { id: "v", valveId: "a", branch: "main", isOpen: false, note: "", changedAt: AT } },
    ];
    for (const op of sent) await expect(trpcTransport.send(op)).resolves.toEqual({ outcome: "applied" });
    expect(m.addAsset).toHaveBeenCalledWith({ eventId: "e1", workOrderId: J, assetId: "a", occurredAt: new Date(AT) });
    expect(m.woCreate).toHaveBeenCalledWith(expect.objectContaining({ location: { latitude: -1, longitude: 36 }, areaId: null }));
    expect(m.recordValve).toHaveBeenCalledWith(expect.objectContaining({ changedAt: new Date(AT) }));
  });

  it("sends the completing event with its position and completion data, and reads the outcome", async () => {
    m.transition.mockResolvedValue({ order: {}, outcome: "rejected", reason: "Add a photo of the finished work", replayed: false });
    const done = await trpcTransport.send({
      proc: "workOrders.transition",
      input: { eventId: "e9", workOrderId: J, occurredAt: AT, position: { latitude: -1.3, longitude: 36.8 }, action: { type: "complete", outcome: "done", note: "", capture: { workDone: "Replaced the coupling" } } },
    });
    expect(done).toEqual({ outcome: "rejected", reason: "Add a photo of the finished work" });
    expect(m.transition).toHaveBeenCalledWith(expect.objectContaining({ occurredAt: new Date(AT), position: { latitude: -1.3, longitude: 36.8 }, action: expect.objectContaining({ capture: { workDone: "Replaced the coupling" } }) }));
  });

  it("passes through replayed, unchanged and stale answers", async () => {
    for (const outcome of ["replayed", "unchanged", "stale"] as const) {
      m.recordCondition.mockResolvedValueOnce({ log: {}, outcome });
      await expect(trpcTransport.send(condition())).resolves.toEqual({ outcome });
    }
  });
});

describe("refusals and failures", () => {
  it("reports a refusal about the op as rejected, with the server's words", async () => {
    for (const code of ["BAD_REQUEST", "FORBIDDEN", "CONFLICT"]) {
      m.recordCondition.mockRejectedValueOnce(trpcError(code, "Not allowed here"));
      await expect(trpcTransport.send(condition())).resolves.toEqual({ outcome: "rejected", reason: "Not allowed here" });
    }
  });

  it("throws, so the op is retried, when the connection fails, the session ended or something hasn't arrived yet", async () => {
    m.recordCondition.mockRejectedValueOnce(new TypeError("Network request failed"));
    await expect(trpcTransport.send(condition())).rejects.toThrow("Network request failed");
    m.recordCondition.mockRejectedValueOnce(trpcError("UNAUTHORIZED", "Sign in"));
    await expect(trpcTransport.send(condition())).rejects.toBeTruthy();
    m.recordCondition.mockRejectedValueOnce(trpcError("NOT_FOUND", "Asset not found"));
    await expect(trpcTransport.send(condition())).rejects.toBeTruthy();
    m.recordCondition.mockRejectedValueOnce(trpcError("INTERNAL_SERVER_ERROR", "boom"));
    await expect(trpcTransport.send(condition())).rejects.toBeTruthy();
  });
});

describe("photo upload", () => {
  const photo: Op = {
    proc: "files.upload",
    input: { id: "f1", subjectKind: "work_order", subjectId: J, fileName: "p.jpg", mimeType: "image/jpeg", sizeBytes: 10, path: "attachments/p.jpg", position: { latitude: -1, longitude: 36 }, capturedAt: AT },
  };

  it("announces, PUTs the bytes, confirms, then removes the phone's copy", async () => {
    await expect(trpcTransport.send(photo)).resolves.toEqual({ outcome: "applied" });
    expect(m.calls).toEqual(["announce", "put", "confirm"]);
    expect(m.announce).toHaveBeenCalledWith({ id: "f1", subjectKind: "work_order", subjectId: J, fileName: "p.jpg", mimeType: "image/jpeg", sizeBytes: 10, latitude: -1, longitude: 36, capturedAt: new Date(AT) });
    // The native upload sets Content-Length itself.
    expect(m.upload).toHaveBeenCalledWith("https://bucket.example/put", { httpMethod: "PUT", uploadType: 0, headers: { "Content-Type": "image/jpeg" } });
    expect(m.remove).toHaveBeenCalledTimes(1);
  });

  it("skips the bytes when they already arrived on an earlier try", async () => {
    m.announce.mockResolvedValue({ file: { status: "uploaded" }, upload: null });
    await trpcTransport.send(photo);
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.confirm).toHaveBeenCalled();
  });

  it("refuses a server that cannot take files, and a file that is gone, without retrying forever", async () => {
    m.announce.mockResolvedValueOnce({ file: { status: "pending" }, upload: { url: "memory://k", headers: {} } });
    await expect(trpcTransport.send(photo)).resolves.toMatchObject({ outcome: "rejected", reason: expect.stringContaining("no file storage") });
    m.exists.mockReturnValue(false);
    await expect(trpcTransport.send(photo)).resolves.toMatchObject({ outcome: "rejected", reason: "This file is no longer on the phone" });
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("retries when the storage says the file isn't there yet, and when the PUT fails", async () => {
    m.confirm.mockRejectedValueOnce(trpcError("PRECONDITION_FAILED", "The file hasn't finished uploading"));
    await expect(trpcTransport.send(photo)).rejects.toThrow("hasn't finished uploading");
    expect(m.remove).not.toHaveBeenCalled();
    m.upload.mockResolvedValueOnce({ status: 503, body: "", headers: {} });
    await expect(trpcTransport.send(photo)).rejects.toThrow("The upload failed (503)");
  });

  it("rejects a file whose size didn't match, so the person adds it again", async () => {
    m.confirm.mockResolvedValueOnce({ file: null, problem: "The uploaded file doesn't match what was announced. Add it again." });
    await expect(trpcTransport.send(photo)).resolves.toEqual({ outcome: "rejected", reason: "The uploaded file doesn't match what was announced. Add it again." });
    expect(m.remove).not.toHaveBeenCalled();
  });
});
