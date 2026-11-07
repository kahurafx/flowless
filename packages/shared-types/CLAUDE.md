# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## `@flowless/shared-types`

Types shared by `apps/web` and `apps/mobile` (both depend on it via `workspace:*`). Shared package conventions are in the root `CLAUDE.md`.

- No build step: apps import `src/index.ts` directly. Export from `src/index.ts`.
- Keep it platform-neutral — no DOM, Node, React Native, or runtime-library imports, since it is compiled by both Next.js and Metro. Prefer type-only exports; small pure helpers (for example `money.ts`, using only `Intl`) are fine.
- Built with `noUncheckedIndexedAccess` and `isolatedModules` (from `@flowless/typescript-config`), so use `export type` for re-exported types.
- After changing types, run `pnpm check-types` from the repo root to catch breakage in both apps.
