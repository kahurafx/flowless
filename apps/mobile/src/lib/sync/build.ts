import type { ReadingOutcome, ReadingQuality } from "@flowless/shared-types";
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

type UploadSubject = { kind: "work_order" | "gis_asset" | "reading"; id: string };

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

/*
 * Readings and visits (M-04, M-06). A photo can only be attached to a reading the server already
 * has, so the record goes first and the uploads after. The record carries the first photo's file id
 * up front (`photoFileId`): the server stores the id and the file arrives later under the same id.
 */
type Located = { latitude: number; longitude: number };

export type VisitSpec = {
  attemptId: string;
  servicePointId: string;
  outcome: ReadingOutcome;
  tags: string[];
  note: string;
  attemptedAt: string;
  cycleDate?: string;
  /** Only for `read_ok`. */
  reading?: { id: string; value: number; quality: ReadingQuality; rolloverConfirmed: boolean; position?: Located };
  /** Photos travel only with a reading: a file needs a subject, and a visit without a reading has none. */
  files: readonly UploadSpec[];
};

export function visitOps(v: VisitSpec): Op[] {
  const photo = v.reading ? v.files[0] : undefined;
  const attempt: Op = {
    proc: "metering.attempts.record",
    input: {
      id: v.attemptId,
      servicePointId: v.servicePointId,
      outcome: v.outcome,
      tags: v.tags,
      note: v.note,
      attemptedAt: v.attemptedAt,
      ...(v.cycleDate ? { cycleDate: v.cycleDate } : {}),
      ...(photo ? { photoFileId: photo.id } : {}),
      ...(v.reading
        ? { reading: { id: v.reading.id, value: v.reading.value, readAt: v.attemptedAt, quality: v.reading.quality, rolloverConfirmed: v.reading.rolloverConfirmed, ...(v.reading.position ?? {}) } }
        : {}),
    },
  };
  return [attempt, ...(v.reading ? uploadOps(v.files, { kind: "reading", id: v.reading.id }) : [])];
}

export function readingOps(input: Extract<Op, { proc: "metering.readings.record" }>["input"], files: readonly UploadSpec[]): Op[] {
  const first = files[0];
  return [{ proc: "metering.readings.record", input: { ...input, ...(first ? { photoFileId: first.id } : {}) } }, ...uploadOps(files, { kind: "reading", id: input.id })];
}

export type MeterChangeSpec = {
  id: string;
  oldMeterId: string;
  newMeterId: string;
  replacedAt: string;
  reason: string;
  final: { id: string; value: number; rolloverConfirmed: boolean; position?: Located };
  initial: { id: string; value: number; position?: Located };
  /** Photos of the old meter's final dial, attached to the final reading. */
  files: readonly UploadSpec[];
};

export function meterChangeOps(m: MeterChangeSpec): Op[] {
  const photo = m.files[0];
  return [
    {
      proc: "metering.installations.replace",
      input: {
        id: m.id,
        oldMeterId: m.oldMeterId,
        newMeterId: m.newMeterId,
        replacedAt: m.replacedAt,
        reason: m.reason,
        finalReading: { id: m.final.id, value: m.final.value, quality: "good", note: "", rolloverConfirmed: m.final.rolloverConfirmed, ...(photo ? { photoFileId: photo.id } : {}), ...(m.final.position ?? {}) },
        initialReading: { id: m.initial.id, value: m.initial.value, quality: "good", note: "", rolloverConfirmed: false, ...(m.initial.position ?? {}) },
      },
    },
    ...uploadOps(m.files, { kind: "reading", id: m.final.id }),
  ];
}
