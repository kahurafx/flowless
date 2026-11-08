import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { uid, now } from "../lib/ids";
import { removeLocal } from "../lib/attachments";
import type { HapticCue } from "../lib/haptics";
import type { Op, SyncItem } from "../lib/sync/ops";
import { isUnsent, uploadPaths } from "../lib/sync/queue";

/**
 * The sync area: the queue of what this phone has done and not yet told the server, whether the
 * phone is online, and the last time it was up to date. `syncNow` itself lives in the provider,
 * because it also re-reads every other area afterwards.
 */
export type SyncValue = {
  queue: SyncItem[];
  /** Items not yet sent (queued or failed). */
  pending: number;
  /** Sent items an engineer has not looked at yet. */
  awaitingReview: number;
  online: boolean;
  /** The person chose to work offline. */
  workOffline: boolean;
  setWorkOffline: (v: boolean) => void;
  syncing: boolean;
  lastSyncedAt: Date | null;
  syncNow: () => Promise<void>;
  /** Send a refused or stuck item again on the next sync. */
  retryItem: (id: string) => void;
  /** Give up on an item, so what's behind it can go. Its files are removed from the phone. */
  discardItem: (id: string) => void;
};

export const SyncContext = createContext<SyncValue | null>(null);
export function useSync(): SyncValue {
  const v = useContext(SyncContext);
  if (!v) throw new Error("useSync must be used inside <AppProvider>");
  return v;
}

export type NewItem = Omit<SyncItem, "id" | "at" | "status" | "ops">;
export type Enqueue = (item: NewItem, ops: Op[], toast?: string, cue?: HapticCue) => void;

export function useSyncState(showToast: (message: string, cue?: HapticCue) => void) {
  const [queue, setQueue] = useState<SyncItem[]>([]);
  const [workOffline, setWorkOffline] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  /** The queue as of the last render, for code that runs later than the render that started it. */
  const queueRef = useRef(queue);
  useLayoutEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  /** Record what was done, and the API calls that will tell the server, in the order they must be sent. */
  const enqueue = useCallback<Enqueue>(
    (item, ops, toast = "Saved to your changes", cue) => {
      setQueue((q) => [{ ...item, ops, id: uid(), at: now(), status: "queued" }, ...q]);
      if (toast) showToast(toast, cue);
    },
    [showToast],
  );

  const retryItem = useCallback((id: string) => {
    const requeue = (q: SyncItem[]): SyncItem[] => q.map((i) => (i.id === id ? { ...i, status: "queued", error: undefined } : i));
    // Also updated now, so a sync started right after this sees it before the next render.
    queueRef.current = requeue(queueRef.current);
    setQueue(requeue);
  }, []);

  const discardItem = useCallback((id: string) => {
    const item = queueRef.current.find((i) => i.id === id);
    for (const path of uploadPaths(item?.ops)) removeLocal({ uri: path });
    setQueue((q) => q.map((i) => (i.id === id ? { ...i, status: "dropped", error: undefined } : i)));
  }, []);

  return { queue, setQueue, queueRef, workOffline, setWorkOffline, syncing, setSyncing, lastSyncedAt, setLastSyncedAt, enqueue, retryItem, discardItem, isUnsent };
}
