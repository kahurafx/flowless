# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## `@flowless/typescript-config`

Shared tsconfig (`base.json`) extended by every `packages/*` workspace via `"extends": "@flowless/typescript-config/base.json"`. The apps do **not** use it (web uses Next's tsconfig, mobile uses `expo/tsconfig.base`).

- Settings: ES2022, `moduleResolution: Bundler`, `strict`, `noUncheckedIndexedAccess`, `isolatedModules`, `noEmit`.
- `noEmit` is deliberate — packages ship raw TS and are compiled by the consuming app. Don't enable emit without adding a build step and changing package `exports`.
- Changes here affect all packages; verify with `pnpm check-types` from the root.
