import {
  ATTEMPT_MAX_TAGS,
  expectedDialRange,
  parseDialValue,
  READING_OUTCOMES,
  splitFlags,
  validateReadingEntry,
  type ReadingEntryResult,
  type ReadingNeighbour,
  type ReadingOutcome,
} from "@flowless/shared-types";

/*
 * The reading round (M-06, M-08, M-09), free of React and of the network so it is testable in Node.
 * Tasks come from `snapshots.tasks`; the phone adds what it needs to validate offline (the meter's
 * dial width, the previous actual reading and a little history, all derived at pull time from the
 * server's readings, never typed in).
 */

export type TaskState = "to_read" | "read" | "missed";

/** One service point on a route's round for one cycle, as this phone holds it. */
export type RoundTask = {
  /** `<snapshotId>:<servicePointId>`. */
  id: string;
  snapshotId: string;
  routeId: string;
  cycleDate: string;
  servicePointId: string;
  accountId: string;
  accountNumber: string | null;
  meterId: string | null;
  walkingSequence: number | null;
  state: TaskState;
  lastOutcome: ReadingOutcome | null;
  meter: { serial: string; dialDigits: number } | null;
  /** Latest valid, cleared, actual reading of this meter: the baseline. */
  previous: ReadingNeighbour | null;
  /** Cleared actual readings before `previous`, newest first. */
  history: ReadingNeighbour[];
  /** Changed on this phone and not yet confirmed by a pull. */
  pending?: boolean;
};

/** One route's round: which snapshot, for what cycle. */
export type Round = { id: string; routeId: string; routeName: string; cycleDate: string };

export const taskKey = (snapshotId: string, servicePointId: string) => `${snapshotId}:${servicePointId}`;

/** Walking sequence first (those without one go last), then account number, so a route reads in a stable order. */
export function orderTasks<T extends Pick<RoundTask, "walkingSequence" | "accountNumber" | "servicePointId">>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => {
    const sa = a.walkingSequence ?? Number.POSITIVE_INFINITY;
    const sb = b.walkingSequence ?? Number.POSITIVE_INFINITY;
    if (sa !== sb) return sa < sb ? -1 : 1;
    const byAccount = (a.accountNumber ?? "").localeCompare(b.accountNumber ?? "", undefined, { numeric: true });
    return byAccount || a.servicePointId.localeCompare(b.servicePointId);
  });
}

/** Search by account number, meter serial or the start of a service point id. Blank matches everything. */
export function searchTasks<T extends Pick<RoundTask, "accountNumber" | "meter" | "servicePointId">>(tasks: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...tasks];
  return tasks.filter((t) => (t.accountNumber ?? "").toLowerCase().includes(q) || (t.meter?.serial ?? "").toLowerCase().includes(q) || t.servicePointId.toLowerCase().startsWith(q));
}

export function countByState(tasks: readonly Pick<RoundTask, "state">[]): Record<TaskState, number> {
  const out: Record<TaskState, number> = { to_read: 0, read: 0, missed: 0 };
  for (const t of tasks) out[t.state]++;
  return out;
}

/**
 * The newest snapshot of each route, newest cycle first, at most `max` routes: the rounds the phone
 * keeps. Older cycles are history, not work.
 */
export function latestPerRoute<T extends { routeId: string; cycleDate: string; takenAt: Date }>(snapshots: readonly T[], max: number): T[] {
  const best = new Map<string, T>();
  for (const s of snapshots) {
    const cur = best.get(s.routeId);
    if (!cur || s.cycleDate > cur.cycleDate || (s.cycleDate === cur.cycleDate && s.takenAt > cur.takenAt)) best.set(s.routeId, s);
  }
  return [...best.values()].sort((a, b) => (a.cycleDate < b.cycleDate ? 1 : a.cycleDate > b.cycleDate ? -1 : 0)).slice(0, max);
}

/** A reading as the server lists it, narrowed to what the baseline needs. */
export type PastReading = { meterId: string; value: number; readAt: Date; kind: string; status: string; cleared: boolean };

/** Baseline and history of one meter, from its readings (any order): valid, cleared, actual, newest first. */
export function baselineOf(meterId: string, readings: readonly PastReading[]): { previous: ReadingNeighbour | null; history: ReadingNeighbour[] } {
  const usable = readings
    .filter((r) => r.meterId === meterId && r.kind === "actual" && r.status === "valid" && r.cleared)
    .sort((a, b) => b.readAt.getTime() - a.readAt.getTime())
    .map((r) => ({ value: r.value, readAt: r.readAt }));
  return { previous: usable[0] ?? null, history: usable.slice(1) };
}

/** The local day of an instant, for the same-day duplicate check (the device's zone stands in for the organization's). */
const dayOf = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export type VisitCheck =
  | { ok: false; error: string }
  | {
      ok: true;
      value: number;
      result: ReadingEntryResult;
      blocking: string[];
      advisory: string[];
      /** The drop looks like the dial going round: the reader must say so before it can be saved (M-07). */
      needsRolloverConfirmation: boolean;
      hint: { min: number; max: number | null; perDay: number | null } | null;
    };

/**
 * What the reader sees before saving a reading. Mirrors the server's checks (shared-types port) with
 * what the phone knows; the server decides in the end, so a blocking flag is shown but does not stop
 * the reader: a doubtful reading is better recorded and reviewed than lost.
 */
export function checkVisit(task: Pick<RoundTask, "meter" | "previous" | "history">, text: string, now: Date, rolloverConfirmed: boolean): VisitCheck {
  const dial = task.meter?.dialDigits;
  if (!dial) return { ok: false, error: "This service point has no meter on the phone. Pull to refresh when online." };
  const parsed = parseDialValue(text, dial);
  if (!parsed.ok) return parsed;
  const result = validateReadingEntry({
    value: parsed.value,
    readAt: now,
    dialDigits: dial,
    purpose: "routine",
    rolloverConfirmed,
    previous: task.previous,
    next: null,
    history: task.history,
    sameDayDuplicate: !!task.previous && dayOf(task.previous.readAt) === dayOf(now),
    inClosedPeriod: false,
  });
  const { blocking, advisory } = splitFlags(result.flags);
  return {
    ok: true,
    value: parsed.value,
    result,
    blocking,
    advisory,
    needsRolloverConfirmation: result.flags.includes("ROLLOVER_CANDIDATE"),
    hint: expectedDialRange(task.previous, task.history, now),
  };
}

/** What the reader may tick on a visit that found a problem. Free text is allowed too; the server keeps up to 12. */
export const SUGGESTED_TAGS = ["dog", "locked gate", "no access", "meter buried", "meter flooded", "cracked glass", "tampered", "customer absent", "hazard"] as const;

export const OUTCOME_LABEL: Record<ReadingOutcome, string> = {
  read_ok: "Read",
  meter_inaccessible: "Meter inaccessible",
  meter_faulty: "Meter faulty",
  no_meter_found: "No meter found",
  locked_premises: "Premises locked",
  dog_or_hazard: "Dog or hazard",
  customer_refused: "Customer refused",
  illegal_connection_suspected: "Illegal connection suspected",
};

/** The misses, in the order the picker shows them. `read_ok` is the Read screen. */
export const MISS_OUTCOMES = READING_OUTCOMES.filter((o) => o !== "read_ok");

export const cleanTags = (tags: readonly string[]): string[] => [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, ATTEMPT_MAX_TAGS);

/** What a task looks like after the person records a visit, before the server confirms it. */
export function afterVisit(task: RoundTask, outcome: ReadingOutcome): RoundTask {
  return { ...task, state: outcome === "read_ok" ? "read" : "missed", lastOutcome: outcome, pending: true };
}

/** After a meter change: the new meter, with its initial reading as the baseline (no history). */
export function afterMeterChange(task: RoundTask, meter: { id: string; serial: string; dialDigits: number }, initial: { value: number; readAt: Date }): RoundTask {
  return { ...task, meterId: meter.id, meter: { serial: meter.serial, dialDigits: meter.dialDigits }, previous: initial, history: [], pending: true };
}

/** The server's task row, narrowed to what `assembleTasks` reads. */
export type ServerTaskLike = {
  accountId: string;
  accountNumber?: string | undefined;
  servicePointId: string;
  routeId: string;
  meterId: string | null;
  walkingSequence: number | null;
  state: TaskState;
  lastAttempt: { outcome: ReadingOutcome } | null;
};

/** Put a snapshot's server tasks together with the meters and readings fetched for them. */
export function assembleTasks(
  snapshot: { id: string; routeId: string; cycleDate: string },
  tasks: readonly ServerTaskLike[],
  meters: ReadonlyMap<string, { serial: string; dialDigits: number }>,
  readingsByMeter: ReadonlyMap<string, readonly PastReading[]>,
): RoundTask[] {
  return tasks.map((t) => {
    const base = t.meterId ? baselineOf(t.meterId, readingsByMeter.get(t.meterId) ?? []) : { previous: null, history: [] };
    return {
      id: taskKey(snapshot.id, t.servicePointId),
      snapshotId: snapshot.id,
      routeId: snapshot.routeId,
      cycleDate: snapshot.cycleDate,
      servicePointId: t.servicePointId,
      accountId: t.accountId,
      accountNumber: t.accountNumber ?? null,
      meterId: t.meterId,
      walkingSequence: t.walkingSequence,
      state: t.state,
      lastOutcome: t.lastAttempt?.outcome ?? null,
      meter: t.meterId ? (meters.get(t.meterId) ?? null) : null,
      previous: base.previous,
      history: base.history,
    };
  });
}

/** Run `fn` over `items` a few at a time: a long route is hundreds of lookups, and a batch URL has a limit. */
export async function inChunks<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}
