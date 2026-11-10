import type { ReadingOutcome, ReadingQuality } from "@flowless/shared-types";
import { createContext, useContext, useMemo, useState } from "react";
import { toUploadSpec } from "../lib/attachments";
import { now, uid } from "../lib/ids";
import { afterMeterChange, afterVisit, cleanTags, OUTCOME_LABEL, type Round, type RoundTask } from "../lib/readings";
import { meterChangeOps, visitOps } from "../lib/sync/build";
import type { LocalFile } from "../lib/types";
import type { Enqueue } from "./sync";
import { useActions } from "./use-actions";

/**
 * The reading round (M-06 to M-09): the route's tasks cached for offline use, and the actions on
 * them. A visit updates the task on the phone at once and queues `metering.attempts.record` (with the
 * reading when it was read); a meter change queues `metering.installations.replace`. Both carry
 * client-minted ids, so a retried sync is safe.
 */
export type VisitInput = {
  task: RoundTask;
  outcome: ReadingOutcome;
  tags?: string[];
  note?: string;
  files?: LocalFile[];
  /** `read_ok` only. */
  reading?: { value: number; quality: ReadingQuality; rolloverConfirmed: boolean; position?: { latitude: number; longitude: number } };
};

export type MeterChangeInput = {
  task: RoundTask;
  newMeter: { id: string; serial: string; dialDigits: number };
  finalValue: number;
  finalRolloverConfirmed: boolean;
  initialValue: number;
  reason: string;
  files?: LocalFile[];
  position?: { latitude: number; longitude: number };
};

export type ReadingsValue = {
  rounds: Round[];
  tasks: RoundTask[];
  recordVisit: (input: VisitInput) => void;
  changeMeter: (input: MeterChangeInput) => void;
};

export const ReadingsContext = createContext<ReadingsValue | null>(null);
export function useReadings(): ReadingsValue {
  const v = useContext(ReadingsContext);
  if (!v) throw new Error("useReadings must be used inside <AppProvider>");
  return v;
}

export function useReadingsState(deps: { enqueue: Enqueue }) {
  const [rounds, setRounds] = useState<Round[]>([]);
  const [tasks, setTasks] = useState<RoundTask[]>([]);

  const patch = (id: string, change: (t: RoundTask) => RoundTask) => setTasks((ts) => ts.map((t) => (t.id === id ? change(t) : t)));

  const recordVisit: ReadingsValue["recordVisit"] = ({ task, outcome, tags = [], note = "", files = [], reading }) => {
    const at = now();
    const specs = outcome === "read_ok" ? files.map(toUploadSpec) : [];
    patch(task.id, (t) => afterVisit(t, outcome));
    deps.enqueue(
      {
        kind: outcome === "read_ok" ? "reading" : "attempt",
        assetId: null,
        title: outcome === "read_ok" ? "Meter reading" : OUTCOME_LABEL[outcome],
        assetName: task.accountNumber ?? "Service point",
        detail: outcome === "read_ok" && reading ? `Dial ${reading.value}` : cleanTags(tags).join(", ") || OUTCOME_LABEL[outcome],
      },
      visitOps({
        attemptId: uid(),
        servicePointId: task.servicePointId,
        outcome,
        tags: cleanTags(tags),
        note: note.trim(),
        attemptedAt: at,
        cycleDate: task.cycleDate,
        ...(outcome === "read_ok" && reading ? { reading: { id: uid(), ...reading } } : {}),
        files: specs,
      }),
    );
  };

  const changeMeter: ReadingsValue["changeMeter"] = (input) => {
    const { task, newMeter } = input;
    if (!task.meterId) return;
    const at = now();
    patch(task.id, (t) => afterMeterChange(t, newMeter, { value: input.initialValue, readAt: new Date(at) }));
    deps.enqueue(
      { kind: "meter", assetId: null, title: "Meter change", assetName: task.accountNumber ?? "Service point", detail: `${task.meter?.serial ?? "Old meter"} to ${newMeter.serial}` },
      meterChangeOps({
        id: uid(),
        oldMeterId: task.meterId,
        newMeterId: newMeter.id,
        replacedAt: at,
        reason: input.reason.trim(),
        final: { id: uid(), value: input.finalValue, rolloverConfirmed: input.finalRolloverConfirmed, ...(input.position ? { position: input.position } : {}) },
        initial: { id: uid(), value: input.initialValue, ...(input.position ? { position: input.position } : {}) },
        files: (input.files ?? []).map(toUploadSpec),
      }),
    );
  };

  const actions = useActions({ recordVisit, changeMeter });
  const value = useMemo<ReadingsValue>(() => ({ rounds, tasks, ...actions }), [rounds, tasks, actions]);
  return { value, setRounds, setTasks };
}
