# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## `worker`

The background process (NF-12). Today it is the outbox dispatcher (K-09); queued jobs arrive with A7.

- `src/main.ts`: loops `dispatchOutbox(db, consumers)` from `@flowless/api` until SIGINT/SIGTERM, one JSON log line per batch. Polls every `WORKER_IDLE_MS` (default 1000) and goes again at once after a full batch (`WORKER_BATCH`, default 50). Connects with `DATABASE_URL` (the app role): no RLS bypass; consumers run inside their event's tenant.
- `src/replay.ts` (`pnpm --filter worker replay -- --consumer <name> --organization <id> [--since <date>]`): re-delivers processed events to one consumer with `replay: true`.
- Holds no business logic: events, consumers and the dispatcher live in `packages/api` (`kernel/events.ts`, `kernel/consumers.ts`), so tests drive them directly. Several workers may run at once; claims use `FOR UPDATE SKIP LOCKED` with a lease.
- `pnpm dev` (root) starts it with `tsx watch`; `pnpm --filter worker start` runs it once.
