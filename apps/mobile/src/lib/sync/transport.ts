import { readingFlagLabel } from "@flowless/shared-types";
import { TRPCClientError } from "@trpc/client";
import { UploadType } from "expo-file-system";
import { api } from "../api";
import { fileAt } from "../attachments";
import type { Op, OpOutcome, Transport } from "./ops";

/**
 * Delivers one operation to the server. Throwing means "didn't get through" (offline, timeout, 5xx,
 * the session ended): the op stays queued and is retried. A NOT_FOUND for something that hasn't
 * arrived yet also throws, so it is retried after the op it depends on. A refusal that is about this
 * op (BAD_REQUEST, FORBIDDEN, CONFLICT) comes back as `rejected` and doesn't hold up the queue.
 */

type UploadOp = Extract<Op, { proc: "files.upload" }>;

/** The server said no in a way that is about this op, not the connection. Sending it again wouldn't help. */
class Refused extends Error {}

const at = (iso: string) => new Date(iso);

/** Announce the file, PUT its bytes, confirm. Each step is safe to repeat, so a retry just carries on. */
async function upload({ input }: UploadOp): Promise<OpOutcome> {
  const { path, position, capturedAt, ...announced } = input;
  const { file: row, upload: target } = await api.files.announce.mutate({
    ...announced,
    ...(position ? position : {}),
    ...(capturedAt ? { capturedAt: at(capturedAt) } : {}),
  });
  // No target: the bytes already arrived on an earlier try.
  if (target && row.status === "pending") {
    // A server with no S3 settings keeps files in memory, which a phone can't reach.
    if (target.url.startsWith("memory://")) throw new Refused("The server has no file storage set up, so this file can't be uploaded");
    const file = fileAt(path);
    if (!file.exists) throw new Refused("This file is no longer on the phone");
    // The native upload sets Content-Length itself from the body.
    const { "Content-Length": _length, ...headers } = target.headers;
    const sent = await file.upload(target.url, { httpMethod: "PUT", uploadType: UploadType.BINARY_CONTENT, headers });
    if (sent.status < 200 || sent.status >= 300) throw new Error(`The upload failed (${sent.status})`);
  }
  try {
    const { problem } = await api.files.confirm.mutate({ id: input.id });
    if (problem) return { outcome: "rejected", reason: problem };
  } catch (err) {
    // "Hasn't finished uploading" is about timing, not about this file: try again later.
    if (err instanceof TRPCClientError && err.data?.code === "PRECONDITION_FAILED") throw new Error(err.message);
    throw err;
  }
  // On the server now, so the phone's copy has done its job.
  try {
    fileAt(path).delete();
  } catch {
    /* already gone */
  }
  return { outcome: "applied" };
}

/** A job's branch comes from the server: a job raised on this phone doesn't know its real code until it has arrived. */
async function branchFor(op: { input: { branch: string }; workOrderId?: string }) {
  return op.workOrderId ? (await api.workOrders.changeSet.mutate({ workOrderId: op.workOrderId })).branch : op.input.branch;
}

/**
 * A reading the server kept but holds for review (a blocking validation flag, M-05) is neither a
 * refusal nor a plain success: it is reported `stale` ("kept as history") with the reasons, so the
 * Sync screen shows it. A replay answers `replayed`.
 */
function held(res: { replayed?: boolean; reading?: { flags: string[]; cleared: boolean } | null; finalReading?: { flags: string[]; cleared: boolean }; initialReading?: { flags: string[]; cleared: boolean } }): OpOutcome {
  if (res.replayed) return { outcome: "replayed" };
  const unclear = [res.reading, res.finalReading, res.initialReading].find((r) => r && !r.cleared);
  if (unclear) return { outcome: "stale", reason: `Held for review: ${unclear.flags.map(readingFlagLabel).join("; ") || "needs approval"}` };
  return { outcome: "applied" };
}

/** Spelled out per proc so the compiler checks every Op's input against the real procedure. */
async function call(op: Op): Promise<{ outcome?: string; reason?: string } | object> {
  switch (op.proc) {
    case "gis.logs.recordCondition":
      return api.gis.logs.recordCondition.mutate({ ...op.input, branch: await branchFor(op), recordedAt: at(op.input.recordedAt) });
    case "gis.logs.recordValveState":
      return api.gis.logs.recordValveState.mutate({ ...op.input, branch: await branchFor(op), changedAt: at(op.input.changedAt) });
    case "gis.nodes.create":
      return api.gis.nodes.create.mutate({ ...op.input, branch: await branchFor(op) });
    case "gis.pipes.create":
      return api.gis.pipes.create.mutate({ ...op.input, branch: await branchFor(op) });
    case "gis.structures.create":
      return api.gis.structures.create.mutate({ ...op.input, branch: await branchFor(op) });
    case "gis.connections.create":
      return api.gis.connections.create.mutate({ ...op.input, branch: await branchFor(op) });
    case "workOrders.create":
      return api.workOrders.create.mutate(op.input);
    case "workOrders.changeSet":
      return api.workOrders.changeSet.mutate({ workOrderId: op.input.workOrderId, occurredAt: at(op.input.occurredAt) });
    case "workOrders.addAsset":
      return api.workOrders.addAsset.mutate({ ...op.input, occurredAt: at(op.input.occurredAt) });
    case "workOrders.linkLog":
      return api.workOrders.linkLog.mutate({ ...op.input, occurredAt: at(op.input.occurredAt) });
    case "workOrders.transition":
      return api.workOrders.transition.mutate({ ...op.input, occurredAt: at(op.input.occurredAt) });
    case "workOrders.review":
      return api.workOrders.review.mutate({ ...op.input, occurredAt: at(op.input.occurredAt) });
    case "workOrders.finalize":
      return api.workOrders.finalize.mutate({ ...op.input, occurredAt: at(op.input.occurredAt) });
    case "metering.readings.record":
      return held(await api.metering.readings.record.mutate({ ...op.input, readAt: at(op.input.readAt) }));
    case "metering.attempts.record": {
      const { reading, attemptedAt, ...rest } = op.input;
      return held(await api.metering.attempts.record.mutate({ ...rest, attemptedAt: at(attemptedAt), ...(reading ? { reading: { ...reading, source: "technician" as const, readAt: at(reading.readAt) } } : {}) }));
    }
    case "metering.installations.replace":
      return held(await api.metering.installations.replace.mutate({ ...op.input, replacedAt: at(op.input.replacedAt) }));
    case "files.upload":
      return upload(op);
  }
}

/** The server looked at this and said no. Sending it again gives the same answer, so it mustn't hold up the queue. */
const REFUSED = new Set(["BAD_REQUEST", "FORBIDDEN", "CONFLICT", "UNPROCESSABLE_CONTENT"]);

const OUTCOMES = new Set(["applied", "unchanged", "stale", "replayed", "rejected"]);

export const trpcTransport: Transport = {
  async send(op) {
    try {
      const res = await call(op);
      const outcome = "outcome" in res && typeof res.outcome === "string" && OUTCOMES.has(res.outcome) ? (res.outcome as OpOutcome["outcome"]) : "applied";
      const reason = "reason" in res && typeof res.reason === "string" && res.reason ? res.reason : undefined;
      return { outcome, ...(reason ? { reason } : {}) };
    } catch (err) {
      if (err instanceof Refused) return { outcome: "rejected", reason: err.message };
      const code = err instanceof TRPCClientError ? (err.data as { code?: string } | undefined)?.code : undefined;
      if (code && REFUSED.has(code)) return { outcome: "rejected", reason: (err as Error).message };
      throw err;
    }
  },
};
