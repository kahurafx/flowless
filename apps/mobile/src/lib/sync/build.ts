import type { GeoPoint, Op } from "./ops";

/** A picked file as the upload op needs it: the app resolves size and the relative path from the file system. */
export type UploadSpec = {
  id: string;
  fileName: string;
  mimeType: Extract<Op, { proc: "files.upload" }>["input"]["mimeType"];
  sizeBytes: number;
  path: string;
  position?: GeoPoint;
  capturedAt?: string;
};

type UploadSubject = { kind: "work_order" | "gis_asset"; id: string };

export const uploadOps = (files: readonly UploadSpec[], subject: UploadSubject): Op[] =>
  files.map((f) => ({ proc: "files.upload", input: { ...f, subjectKind: subject.kind, subjectId: subject.id } }));

/**
 * Finishing a job. The kind may require photos on the job (W-02 `evidence`), and the server counts
 * only photos it has confirmed. So every photo is uploaded and confirmed first, and the completing
 * event goes last. If the order were the other way round, the server would refuse the job for
 * missing evidence that is on its way.
 */
export function finishOps(transition: Extract<Op, { proc: "workOrders.transition" }>, files: readonly UploadSpec[]): Op[] {
  return [...uploadOps(files, { kind: "work_order", id: transition.input.workOrderId }), transition];
}

/** A new record, then its files: a file can only be attached to something the server already knows. */
export const createOps = (create: Op, files: readonly UploadSpec[], subject: UploadSubject): Op[] => [create, ...uploadOps(files, subject)];

/** How many more photos a job needs before the kind's evidence rule is met, counting what is already on the server. */
export function photosStillNeeded(evidence: { photos: number } | undefined, onJob: number, picked: number): number {
  return Math.max(0, (evidence?.photos ?? 0) - onJob - picked);
}
