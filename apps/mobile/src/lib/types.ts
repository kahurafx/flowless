import type { api, Out } from "./api";

/*
 * What the server sends, taken from the procedures themselves so a change to the API is a compile
 * error here. Type-only imports: this file (and everything that imports only from it) runs in Node
 * for the unit tests.
 */
export type ServerNode = Out<typeof api.gis.nodes.list.query>[number];
export type Pipe = Out<typeof api.gis.pipes.list.query>[number];
export type Structure = Out<typeof api.gis.structures.list.query>[number];
export type Connection = Out<typeof api.gis.connections.list.query>[number];
export type Dma = Out<typeof api.gis.dmas.list.query>[number];
export type Subnetwork = Out<typeof api.gis.subnetworks.list.query>[number];
export type Area = Out<typeof api.hierarchy.areas.query>[number];
/** `syncedAt` is null while the record is still only on this phone. */
export type ConditionLog = Omit<Out<typeof api.gis.logs.conditionFeed.query>[number], "syncedAt"> & { syncedAt: Date | null };
export type ValveLog = Omit<Out<typeof api.gis.logs.valveFeed.query>[number], "syncedAt"> & { syncedAt: Date | null };

export type WorkOrder = Out<typeof api.workOrders.list.query>[number];
export type JobAsset = WorkOrder["assets"][number];
export type WorkKind = Out<typeof api.workOrders.kinds.query>[number];
export type { WorkOrderOutcome, WorkOrderStatus } from "@flowless/shared-types";

export type BranchRow = Out<typeof api.gis.reconcile.branches.query>[number];
export type BranchPreview = Out<typeof api.gis.reconcile.preview.query>;
export type PostResult = Out<typeof api.gis.reconcile.post.mutate>;

/** A point on the GIS wire: `{ lat, lng }`. Work orders and files use `{ latitude, longitude }` (GeoPoint). */
export type LatLng = { lat: number; lng: number };

/** A photo or file picked on this phone, waiting to upload. */
export type LocalFile = {
  /** Minted here (a uuid), so a retried upload is the same file. */
  id: string;
  kind: "photo" | "document";
  /** Inside app storage, so it survives cache clearing and can wait offline for upload. */
  uri: string;
  fileName: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "application/pdf";
  sizeBytes: number | null;
  /** Where and when it was taken, if known (W-02 geotag). */
  position?: { latitude: number; longitude: number };
  capturedAt?: string;
};

/** A network node as this phone holds it: the server's row, or one created here and not yet sent. */
export type AppNode = ServerNode & { attachments?: LocalFile[]; pending?: boolean };

export type SnapshotHead = Out<typeof api.metering.snapshots.list.query>[number];
export type ServerReadingTask = Out<typeof api.metering.snapshots.tasks.query>[number];
export type ServerReading = Out<typeof api.metering.readings.list.query>[number];
export type MeterRow = Out<typeof api.metering.meters.list.query>["meters"][number];
export type RouteRow = Out<typeof api.hierarchy.routes.query>[number];
