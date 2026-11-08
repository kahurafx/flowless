# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## `@flowless/shared-types`

Types shared by `apps/web` and `apps/mobile` (both depend on it via `workspace:*`). Shared package conventions are in the root `CLAUDE.md`.

- No build step: apps import `src/index.ts` directly. Export from `src/index.ts`.
- Keep it platform-neutral — no DOM, Node, React Native, or runtime-library imports, since it is compiled by both Next.js and Metro. Prefer type-only exports; small pure helpers (for example `money.ts`, using only `Intl`) are fine.
- Built with `noUncheckedIndexedAccess` and `isolatedModules` (from `@flowless/typescript-config`), so use `export type` for re-exported types.
- After changing types, run `pnpm check-types` from the repo root to catch breakage in both apps.
- `modules.ts` (K-04): `MODULE_KEYS`, `MODULE_REQUIRES` (hard dependencies only) and `entitlementProblem`.
- `permissions.ts` (K-03): the permission catalogue (`PERMISSION_STATEMENTS`, `"<resource>:<action>"`), `DEFAULT_ROLES` (each a permission array) and `effectivePermissions(role, grants)`. Adding a role or permission here also registers it with Better Auth (`packages/auth/src/access.ts`); give it a label in `apps/web/src/lib/permission-labels.ts`.
- `work.ts` (W-01) and `gis.ts` (G-01): the work-order lifecycle lists (statuses, priorities, review policies, event types and outcomes) and the GIS network lists (node, structure, pipe material, junction and condition types, `STRUCTURE_ATTACHMENT_RULES`, `MAIN_BRANCH`). The `work_orders` and `gis` schemas in packages/db are built from them, so a new value needs a migration.
