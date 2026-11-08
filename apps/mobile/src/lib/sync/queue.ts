import type { Op, OpOutcome, SyncItem, SyncStatus, Transport } from "./ops";

/**
 * The sync loop, free of React and of the network so it can be tested in Node. The app hands it the
 * unsent items (oldest first) and a `Transport`; it sends each item's ops in order and reports how
 * each item ended.
 *
 *  - Items go up in the order they were made. Some depend on earlier ones.
 *  - A thrown error means "didn't get through" (offline, timeout, 5xx, or NOT_FOUND because what the
 *    op depends on hasn't arrived). The item is marked `failed` and the run stops, so nothing behind
 *    it overtakes it. The item keeps all its ops and ids, so the next run repeats it safely.
 *  - A `rejected` answer is the server saying no to this op. Its item stops there (later ops in the
 *    item depend on it) but the rest of the queue carries on.
 *  - `stale` keeps the log as history but leaves the asset alone; later ops still make sense.
 */

export const isUnsent = (item: Pick<SyncItem, "status">) => item.status === "queued" || item.status === "failed";

/**
 * The item shows the most telling answer: rejected beats stale, which beats applied (something
 * really changed), which beats "already received" and "no change needed".
 */
const WEIGHT: Record<OpOutcome["outcome"], number> = { unchanged: 1, replayed: 1, applied: 2, stale: 3, rejected: 4 };
export function worse(current: OpOutcome["outcome"] | null, next: OpOutcome["outcome"]): OpOutcome["outcome"] {
  return current === null || WEIGHT[next] > WEIGHT[current] ? next : current;
}

export type ItemUpdate = Pick<SyncItem, "status"> & { error?: string };

export type SyncRun = {
  /** Items that reached an answer (anything but failed). */
  sent: number;
  /** The item that didn't get through, if the run stopped. */
  stoppedAt: string | null;
  /** Some item came back rejected or stale. */
  refused: boolean;
};

export async function runQueue(
  due: readonly SyncItem[],
  transport: Transport,
  update: (id: string, patch: ItemUpdate) => void,
): Promise<SyncRun> {
  const run: SyncRun = { sent: 0, stoppedAt: null, refused: false };
  for (const item of due) {
    let answer: OpOutcome["outcome"] | null = null;
    let error: string | undefined;
    try {
      for (const op of item.ops ?? []) {
        const res = await transport.send(op);
        const before = answer;
        answer = worse(answer, res.outcome);
        if (answer !== before && (res.outcome === "rejected" || res.outcome === "stale")) error = res.reason;
        if (res.outcome === "rejected") break;
      }
    } catch (err) {
      run.stoppedAt = item.id;
      update(item.id, { status: "failed", error: err instanceof Error ? err.message : "Couldn't reach the server" });
      return run;
    }
    // An item with no ops (nothing to tell the server) is simply done.
    const status: SyncStatus = answer ?? "applied";
    if (status === "rejected" || status === "stale") run.refused = true;
    run.sent++;
    update(item.id, { status, error });
  }
  return run;
}

/** What a sync run tells the person. The worst thing that happened wins. */
export function syncMessage(run: { stopped: boolean; pulled: boolean; sent: number; refused: boolean }): { message: string; cue?: "success" | "warning" } {
  if (run.stopped) return { message: "Couldn't upload everything. Try again when you have signal.", cue: "warning" };
  if (!run.pulled) return { message: run.sent ? "Changes uploaded, but couldn't refresh. Try again when you have signal." : "Couldn't reach the server", cue: "warning" };
  if (run.refused) return { message: "Some changes weren't applied. Check the sync screen.", cue: "warning" };
  return run.sent ? { message: "Changes uploaded", cue: "success" } : { message: "Already up to date" };
}

/** Files an item would upload, for cleaning up the phone when it is discarded. */
export const uploadPaths = (ops: readonly Op[] = []) => ops.flatMap((op) => (op.proc === "files.upload" ? [op.input.path] : []));
