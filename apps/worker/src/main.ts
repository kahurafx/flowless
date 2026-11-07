// The outbox dispatcher (K-09, NF-12): delivers events to their consumers until stopped.
// Runs as the app database role; every consumer works inside its event's tenant (RLS).
import { consumers, dispatchOutbox } from "@flowless/api";
import { createDatabase } from "@flowless/db";
import { setTimeout as sleep } from "node:timers/promises";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must be set (see .env.example)");

const BATCH = Number(process.env.WORKER_BATCH ?? 50);
const IDLE_MS = Number(process.env.WORKER_IDLE_MS ?? 1000);

const { db, close } = createDatabase(url, { max: 4 });
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
log({ msg: "worker started", consumers: consumers.map((c) => c.name) });

while (!stop.signal.aborted) {
  try {
    const result = await dispatchOutbox(db, consumers, { batch: BATCH });
    if (result.claimed) log({ msg: "dispatched", ...result });
    // A full batch means more may be waiting: go again without pausing.
    if (result.claimed < BATCH) await sleep(IDLE_MS, undefined, { signal: stop.signal }).catch(() => {});
  } catch (error) {
    // The database is unreachable or the claim failed: say so and keep trying.
    log({ msg: "dispatch failed", error: error instanceof Error ? error.message : String(error) });
    await sleep(5 * IDLE_MS, undefined, { signal: stop.signal }).catch(() => {});
  }
}

log({ msg: "worker stopping" });
await close();
