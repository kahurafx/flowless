// The background process (K-09, NF-12, NF-24): delivers outbox events to their consumers
// and runs queued jobs until stopped. Runs as the app database role; every consumer and
// job works inside its organization (RLS). Failures end up in the exception queue.
import { consumers, dispatchOutbox, jobs, runJobs } from "@flowless/api";
import { createDatabase } from "@flowless/db";
import { setTimeout as sleep } from "node:timers/promises";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must be set (see .env.example)");

const BATCH = Number(process.env.WORKER_BATCH ?? 50);
const JOB_BATCH = Number(process.env.WORKER_JOB_BATCH ?? 5);
const IDLE_MS = Number(process.env.WORKER_IDLE_MS ?? 1000);

const { db, close } = createDatabase(url, { max: 4 });
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
log({ msg: "worker started", consumers: consumers.map((c) => c.name), jobs: jobs.map((j) => j.type) });

while (!stop.signal.aborted) {
  try {
    const events = await dispatchOutbox(db, consumers, { batch: BATCH });
    if (events.claimed) log({ msg: "events", ...events });
    const ran = await runJobs(db, jobs, { batch: JOB_BATCH });
    if (ran.claimed) log({ msg: "jobs", ...ran });
    // A full batch means more may be waiting: go again without pausing.
    if (events.claimed < BATCH && ran.claimed < JOB_BATCH) await sleep(IDLE_MS, undefined, { signal: stop.signal }).catch(() => {});
  } catch (error) {
    // The database is unreachable or the claim failed: say so and keep trying.
    log({ msg: "worker loop failed", error: error instanceof Error ? error.message : String(error) });
    await sleep(5 * IDLE_MS, undefined, { signal: stop.signal }).catch(() => {});
  }
}

log({ msg: "worker stopping" });
await close();
