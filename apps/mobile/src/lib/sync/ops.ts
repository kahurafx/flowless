import type { AssetCondition, JunctionType, NodeType, PipeMaterial, StructureType, WorkOrderOutcome } from "@flowless/shared-types";
import type { LatLng } from "../types";

/**
 * What the phone sends when it syncs: one entry per tRPC mutation, with the input as the API takes it
 * except that dates are ISO strings (the queue is stored as JSON; the transport turns them back into
 * `Date`s for superjson).
 *
 * Every op carries a client-minted uuid (the entity id or the event id). That is what makes a retried
 * sync safe: the server answers a repeat with `replayed` (or hands back the row it already has)
 * instead of doing it twice. Ops go up in the order they were made, because some depend on earlier
 * ones: a log must reach the server before it can be linked to a job, and a node before its photo.
 */
export type GeoPoint = { latitude: number; longitude: number };

export type Op =
  | { proc: "gis.logs.recordCondition"; input: { id: string; assetId: string; branch: string; condition: AssetCondition; note: string; recordedAt: string }; workOrderId?: string }
  | { proc: "gis.logs.recordValveState"; input: { id: string; valveId: string; branch: string; isOpen: boolean; note: string; changedAt: string }; workOrderId?: string }
  | {
      proc: "gis.nodes.create";
      input: {
        id: string;
        branch: string;
        type: NodeType;
        name: string;
        location: LatLng;
        condition: AssetCondition;
        isOpen: boolean | null;
        structureId: string | null;
        junction: { type: JunctionType; mainSizeMm: number; branchSizeMm: number | null } | null;
      };
      /**
       * The asset belongs to this job, so it goes on the job's branch. A job raised on this phone has
       * no code until it reaches the server, so the branch is asked for when this is sent and
       * `input.branch` is replaced.
       */
      workOrderId?: string;
    }
  | { proc: "gis.pipes.create"; input: { id: string; branch: string; fromNodeId: string; toNodeId: string; path: LatLng[]; material: PipeMaterial; diameterMm: number; condition: AssetCondition }; workOrderId?: string }
  | { proc: "gis.structures.create"; input: { id: string; branch: string; type: StructureType; name: string; location: LatLng; condition: AssetCondition }; workOrderId?: string }
  | { proc: "gis.connections.create"; input: { id: string; branch: string; connectionNumber: string; location: LatLng; pipeId: string | null }; workOrderId?: string }
  | {
      proc: "workOrders.create";
      input: {
        id: string;
        title: string;
        description: string;
        kind: string;
        assetId: string | null;
        areaId: string | null;
        location: GeoPoint | null;
        locationNote: string | null;
      };
    }
  | { proc: "workOrders.changeSet"; input: { workOrderId: string; occurredAt: string } }
  | { proc: "workOrders.addAsset"; input: { eventId: string; workOrderId: string; assetId: string; occurredAt: string } }
  | { proc: "workOrders.linkLog"; input: { eventId: string; workOrderId: string; logKind: "condition" | "valve"; logId: string; occurredAt: string } }
  | {
      proc: "workOrders.transition";
      input: {
        eventId: string;
        workOrderId: string;
        occurredAt: string;
        position?: GeoPoint;
        action:
          | { type: "resume" }
          | { type: "hold"; reason: string; note: string }
          /** `capture` is the kind's completion data (W-03), checked by the server against the kind's schema. */
          | { type: "complete" | "submit"; outcome: WorkOrderOutcome; note: string; capture?: Record<string, unknown> };
      };
    }
  | { proc: "workOrders.review"; input: { eventId: string; workOrderId: string; decision: "approve" | "return"; note: string; occurredAt: string } }
  | { proc: "workOrders.finalize"; input: { eventId: string; workOrderId: string; outcome: WorkOrderOutcome; note: string; occurredAt: string } }
  /** Three steps on the wire (announce, PUT the bytes, confirm), one op here. `path` is relative to the documents folder. */
  | {
      proc: "files.upload";
      input: {
        id: string;
        subjectKind: "work_order" | "gis_asset";
        subjectId: string;
        fileName: string;
        mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "application/pdf";
        sizeBytes: number;
        path: string;
        position?: GeoPoint;
        capturedAt?: string;
      };
    };

export type OpName = Op["proc"];

/**
 * How the server answered. Logs answer applied / unchanged / stale / replayed; work-order actions add
 * rejected (with a reason the person needs to see). Creates answer with the entity, which counts as applied.
 */
export type OpOutcome = { outcome: "applied" | "unchanged" | "stale" | "replayed" | "rejected"; reason?: string };

/** Delivers one operation. Throwing means "didn't get through" (offline, timeout, 5xx): the op is retried. */
export interface Transport {
  send(op: Op): Promise<OpOutcome>;
}

export type SyncStatus = "queued" | "failed" | "applied" | "unchanged" | "stale" | "replayed" | "rejected" | "dropped";

/** One thing the person did, with the ops that tell the server about it. The Sync screen lists these. */
export type SyncItem = {
  id: string;
  kind: "condition" | "valve" | "create" | "workorder";
  assetId: string | null;
  title: string;
  assetName: string;
  detail: string;
  at: string;
  status: SyncStatus;
  error?: string;
  ops?: Op[];
  reviewed?: boolean;
};
