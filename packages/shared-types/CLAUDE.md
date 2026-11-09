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
- `accounts.ts` (C-01 to C-03) and `phone.ts` (C-01): `COMMERCIAL_STATUSES`, `SERVICE_STATES`, `CUSTOMER_TYPES`, `CONTACT_CHANNELS`, `CONTACT_KINDS`, `SERVICE_POINT_STATUSES` and `CHECK_DIGIT_SCHEMES` (the `accounts` schema's check constraints are built from them, so a new value needs a migration), plus the `AccountSummary` contract the web mocks use. `parsePhone(raw, callingCode)` normalises to 254-format digits (`valid`), recognises placeholders (empty, or only zeros or one repeated digit after the country code: `placeholder`) and refuses the rest (`invalid`); `callingCodeOf(locale)` picks the code from a locale such as `en-KE`. `normalizePhone` is the older display helper and keeps the number as typed.
- `work.ts` (W-01) and `gis.ts` (G-01): the work-order lifecycle lists (statuses, priorities, review policies, event types and outcomes) and the GIS network lists (node, structure, pipe material, junction and condition types, `STRUCTURE_ATTACHMENT_RULES`, `MAIN_BRANCH`), plus `NODE_PHOTO_RULE` (node types that need a photo before they go live), `DUPLICATE_RADIUS_M` and `personalBranch(userId)` (`fld-<userId>`, the guarded personal branch). The `work_orders` and `gis` schemas in packages/db are built from them, so a new value needs a migration.
- `tariffs.ts` (T-01 to T-03, T-07 to T-10): `TARIFF_TYPES`, `FLAT_BASES`, `CHARGE_TYPES`, `CHARGE_RECURRENCES`, `REVENUE_KINDS` with `revenueKindOf(type)` (deposit is a liability, transfer is non-revenue, the rest revenue), `INVOICE_APPLIES_TO`, `PAYMENT_TERMS_KINDS`, `OVERDUE_ACTIONS`, `LATE_FEE_BASES`, `LATE_FEE_FREQUENCIES` and `DEFAULT_CATEGORIES`. The `tariffs` schema builds its check constraints from them, so a new value needs a migration.
- `accounts.ts` also holds the lifecycle lists (F3a): `ACCOUNT_COMMAND_KINDS` (the `account_command` check is built from it, so a new kind needs a migration; F3b adds its own), `ACTIVATION_GATE_KEYS`, `ACTIVATION_MODES` and `ACTIVATION_CHECK_ACTIONS`. `exceptions.ts` gained `ACCOUNT_NOT_ACTIVE_WITH_METER` (stale accounts reuse the existing `STALE_ACTIVATION`); `apps/web/src/components/status-badges.tsx` has its label.
