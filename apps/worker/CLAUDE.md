# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## `worker`

The background process (NF-12): the outbox dispatcher (K-09) and the job runner. Failures end up in the exception queue (NF-24).

- `src/main.ts`: loops `dispatchOutbox(db, consumers)` and `runJobs(db, jobs)` from `@flowless/api` until SIGINT/SIGTERM, one JSON log line per batch (`WORKER_JOB_BATCH`, default 5 jobs; jobs are leased 15 minutes and renew with `heartbeat`). Polls every `WORKER_IDLE_MS` (default 1000) and goes again at once after a full batch (`WORKER_BATCH`, default 50). Once a minute it also runs `escalateApprovals(db)`, which moves approvals past their SLA into the exception queue (K-05). Connects with `DATABASE_URL` (the app role): no RLS bypass; consumers run inside their event's tenant.
- `src/replay.ts` (`pnpm --filter worker replay -- --consumer <name> --organization <id> [--since <date>]`): re-delivers processed events to one consumer with `replay: true`.
- Holds no business logic: events, consumers, jobs and the runners live in `packages/api` (`kernel/events.ts`, `kernel/consumers.ts`, `kernel/jobs.ts`, `kernel/job-registry.ts`), so tests drive them directly. Several workers may run at once; claims use `FOR UPDATE SKIP LOCKED` with a lease.
- `pnpm dev` (root) starts it with `tsx watch`; `pnpm --filter worker start` runs it once.
